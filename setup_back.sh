#!/usr/bin/env bash
set -euo pipefail

REPO_SLUG="Ilow-Space/IlowObsidianSync"
SSH_REPO="git@github.com:Ilow-Space/IlowObsidianSync.git"
INSTALL_DIR="/opt/ilow-backend"
DB_NAME="ilow_db"
DB_USER="ilow_user"
PORT="3001"

ENDPOINT="http://localhost:${PORT}"

if [ "$EUID" -ne 0 ]; then
  echo "[-] Please run this script with sudo or as root."
  exit 1
fi

echo "[+] Step 1: Installing system dependencies..."
apt-get update
apt-get install -y postgresql postgresql-contrib curl jq git

systemctl enable postgresql
systemctl start postgresql

echo "[+] Step 2: Generating database credentials, API keys, and admin secrets..."
DB_PASS=$(openssl rand -hex 16)
ACCESS_KEY=$(openssl rand -hex 32)
ADMIN_KEY=$(openssl rand -hex 32)

echo "[+] Step 3: Provisioning PostgreSQL database..."
USER_EXISTS=$(sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'")
if [ "$USER_EXISTS" != "1" ]; then
    sudo -u postgres psql -c "CREATE USER $DB_USER WITH PASSWORD '$DB_PASS';"
else
    sudo -u postgres psql -c "ALTER USER $DB_USER WITH PASSWORD '$DB_PASS';"
fi

DB_EXISTS=$(sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'")
if [ "$DB_EXISTS" != "1" ]; then
    sudo -u postgres psql -c "CREATE DATABASE $DB_NAME OWNER $DB_USER;"
fi

echo "[+] Step 4: Configuring permissions..."
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $DB_USER;"
sudo -u postgres psql -d "$DB_NAME" -c "GRANT ALL ON SCHEMA public TO $DB_USER;"

echo "[+] Step 5: Testing PostgreSQL connection..."
if PGPASSWORD="$DB_PASS" psql -h localhost -U "$DB_USER" -d "$DB_NAME" -c "SELECT 1;" > /dev/null 2>&1; then
    echo "[*] Database connection verified!"
else
    echo "[-] Database connection failed."
    exit 1
fi

mkdir -p "$INSTALL_DIR"
DOWNLOAD_SUCCESS=0

echo "[+] Step 6: Obtaining backend binary..."

# Method 1: Try GitHub CLI if authenticated
if command -v gh &> /dev/null && gh auth status &>/dev/null; then
    echo "[*] Attempting download via GitHub CLI..."
    if gh release download --repo "$REPO_SLUG" --pattern "ilow-backend" --dir "$INSTALL_DIR" --clobber &>/dev/null; then
        DOWNLOAD_SUCCESS=1
    fi
fi

# Method 2: Try direct GitHub download
if [ "$DOWNLOAD_SUCCESS" -ne 1 ]; then
    echo "[*] Trying direct release URL download..."
    CURL_AUTH=()
    if [ -n "${GITHUB_TOKEN:-}" ]; then
        CURL_AUTH=(-H "Authorization: Bearer ${GITHUB_TOKEN}")
    fi
    DIRECT_URL="https://github.com/${REPO_SLUG}/releases/latest/download/ilow-backend"
    HTTP_CODE=$(curl -sL -w "%{http_code}" "${CURL_AUTH[@]}" "$DIRECT_URL" -o "$INSTALL_DIR/ilow-backend" || true)
    if [ "$HTTP_CODE" -eq 200 ] && [ -s "$INSTALL_DIR/ilow-backend" ]; then
        DOWNLOAD_SUCCESS=1
    fi
fi

# Method 3: Fallback - Compile directly from source using server SSH key
if [ "$DOWNLOAD_SUCCESS" -ne 1 ]; then
    echo "[!] Release download skipped or unavailable."
    echo "[*] Falling back to local compilation via Go and SSH key..."

    if ! command -v go &> /dev/null; then
        echo "[*] Installing Go compiler..."
        apt-get install -y golang-go
    fi

    BUILD_TMP=$(mktemp -d)
    echo "[*] Cloning repository via SSH ($SSH_REPO)..."
    git clone "$SSH_REPO" "$BUILD_TMP"
    
    echo "[*] Compiling backend binary..."
    (cd "$BUILD_TMP/backend" && CGO_ENABLED=0 go build -ldflags="-s -w" -o "$INSTALL_DIR/ilow-backend")
    
    rm -rf "$BUILD_TMP"
    DOWNLOAD_SUCCESS=1
fi

chmod +x "$INSTALL_DIR/ilow-backend"

echo "[+] Step 7: Generating secure .env file..."
cat <<EOF > "$INSTALL_DIR/.env"
PORT=${PORT}
DATABASE_URL=postgres://${DB_USER}:${DB_PASS}@localhost:5432/${DB_NAME}?sslmode=disable
API_KEY=${ACCESS_KEY}
ADMIN_API_KEY=${ADMIN_KEY}
EOF
chmod 600 "$INSTALL_DIR/.env"

echo "[+] Step 8: Configuring systemd service..."
cat <<EOF > /etc/systemd/system/ilow-backend.service
[Unit]
Description=Ilow Sync Backend Service
After=network.target postgresql.service
Requires=postgresql.service

[Service]
Type=simple
User=root
WorkingDirectory=${INSTALL_DIR}
ExecStart=${INSTALL_DIR}/ilow-backend
Restart=always
RestartSec=5
EnvironmentFile=${INSTALL_DIR}/.env

[Install]
WantedBy=multi-user.target
EOF

echo "[+] Step 9: Starting backend service..."
systemctl daemon-reload
systemctl enable ilow-backend
systemctl restart ilow-backend

echo "[+] Step 10: Inspecting Nginx configuration..."
if command -v nginx &> /dev/null; then
    echo "[*] Nginx detected on system."
    NGINX_MATCH=$(grep -rnE "proxy_pass\s+http://(localhost|127\.0\.0\.1):${PORT}" /etc/nginx/ 2>/dev/null | head -n 1 || true)
    
    if [ -n "$NGINX_MATCH" ]; then
        CONFIG_FILE=$(echo "$NGINX_MATCH" | cut -d: -f1)
        echo "[*] Found active proxy configuration for port $PORT in: $CONFIG_FILE"
        
        # Discover domain name from server_name directive
        SERVER_NAMES=$(grep -iE "^\s*server_name\s+" "$CONFIG_FILE" | head -n 1 | sed -E 's/^\s*server_name\s+([^;]+);/\1/' | tr -s ' ' || true)
        DISCOVERED_DOMAIN=""
        
        for SNAME in $SERVER_NAMES; do
            if [ "$SNAME" != "_" ] && [ "$SNAME" != "localhost" ]; then
                DISCOVERED_DOMAIN="$SNAME"
                break
            fi
        done
        
        if [ -n "$DISCOVERED_DOMAIN" ]; then
            if grep -qE "listen\s+.*443|ssl_certificate" "$CONFIG_FILE"; then
                ENDPOINT="https://${DISCOVERED_DOMAIN}"
            else
                ENDPOINT="http://${DISCOVERED_DOMAIN}"
            fi
            echo "[*] Discovered public domain route: ${ENDPOINT}"
        fi

        # Check for existing header checks in Nginx config
        if grep -qE "(x_api_key|http_x_api_key|http_authorization|ADMIN_API_KEY)" "$CONFIG_FILE"; then
            echo "[*] Nginx configuration already contains token header validation logic."
        else
            echo "[!] No API token verification header detected in Nginx config."
            read -rp "[?] Would you like to inject access token verification into Nginx? (y/N): " INJECT_TOKEN || true
            if [[ "${INJECT_TOKEN:-}" =~ ^[Yy]$ ]]; then
                echo "[*] Creating backup: ${CONFIG_FILE}.bak"
                cp "$CONFIG_FILE" "${CONFIG_FILE}.bak"
                
                sed -i "/proxy_pass http:\/\/\(localhost\|127\.0\.0\.1\):${PORT}/i \        if (\$http_x_api_key != \"${ACCESS_KEY}\") { return 401; }" "$CONFIG_FILE"
                
                echo "[*] Testing updated Nginx configuration..."
                if nginx -t; then
                    systemctl reload nginx
                    echo "[*] Nginx reloaded successfully! Client requests now require 'X-API-Key: ${ACCESS_KEY}'."
                else
                    echo "[-] Nginx configuration test failed. Restoring original backup..."
                    mv "${CONFIG_FILE}.bak" "$CONFIG_FILE"
                    systemctl reload nginx || true
                fi
            fi
        fi
    else
        echo "[*] No active Nginx proxy rule found pointing to localhost:$PORT."
    fi
else
    echo "[*] Nginx is not installed. Skipping web server integration."
fi

echo "[+] Deployment completed!"
echo "--------------------------------------------------------"
echo " Service Status  : $(systemctl is-active ilow-backend)"
echo " Service Endpoint: ${ENDPOINT}"
echo " Access API Key  : ${ACCESS_KEY}"
echo " Admin API Key   : ${ADMIN_KEY}"
echo "--------------------------------------------------------"