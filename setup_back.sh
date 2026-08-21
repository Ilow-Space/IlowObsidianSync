#!/usr/bin/env bash
set -euo pipefail

# Configuration Defaults
REPO_SLUG="${1:-your-org/ilow-sync}"  # Pass repo as $1 or edit default
INSTALL_DIR="/opt/ilow-backend"
DB_NAME="ilow_db"
DB_USER="ilow_user"
PORT="3001"                            # Matches default backend port[cite: 2]

if [ "$EUID" -ne 0 ]; then
  echo "[-] Please run this script with sudo or as root."
  exit 1
fi

echo "[+] Step 1: Checking and installing PostgreSQL..."
if ! command -v psql &> /dev/null; then
    echo "[*] PostgreSQL not found. Installing PostgreSQL and dependencies..."
    apt-get update
    apt-get install -y postgresql postgresql-contrib curl jq
else
    echo "[*] PostgreSQL is already installed."
fi

systemctl enable postgresql
systemctl start postgresql

echo "[+] Step 2: Generating secrets and credentials..."
DB_PASS=$(openssl rand -hex 16)
ADMIN_KEY=$(openssl rand -hex 32)

echo "[+] Step 3: Provisioning PostgreSQL user and database..."
# Check and create user
USER_EXISTS=$(sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'")
if [ "$USER_EXISTS" != "1" ]; then
    echo "[*] Creating database user '$DB_USER'..."
    sudo -u postgres psql -c "CREATE USER $DB_USER WITH PASSWORD '$DB_PASS';"
else
    echo "[*] User '$DB_USER' exists. Updating password..."
    sudo -u postgres psql -c "ALTER USER $DB_USER WITH PASSWORD '$DB_PASS';"
fi

# Check and create database
DB_EXISTS=$(sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'")
if [ "$DB_EXISTS" != "1" ]; then
    echo "[*] Creating database '$DB_NAME'..."
    sudo -u postgres psql -c "CREATE DATABASE $DB_NAME OWNER $DB_USER;"
fi

echo "[+] Step 4: Granting database privileges..."
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $DB_USER;"
sudo -u postgres psql -d "$DB_NAME" -c "GRANT ALL ON SCHEMA public TO $DB_USER;"

echo "[+] Step 5: Testing database connectivity..."
if PGPASSWORD="$DB_PASS" psql -h localhost -U "$DB_USER" -d "$DB_NAME" -c "SELECT 1;" > /dev/null 2>&1; then
    echo "[*] Database connection test successful!"
else
    echo "[-] Database connection failed."
    exit 1
fi

echo "[+] Step 6: Setting up application directory at $INSTALL_DIR..."
mkdir -p "$INSTALL_DIR"

echo "[+] Step 7: Downloading latest release binary from GitHub ($REPO_SLUG)..."
LATEST_RELEASE_JSON=$(curl -sL "https://api.github.com/repos/$REPO_SLUG/releases/latest")
DOWNLOAD_URL=$(echo "$LATEST_RELEASE_JSON" | jq -r '.assets[] | select(.name=="ilow-backend") | .browser_download_url')

if [ -z "$DOWNLOAD_URL" ] || [ "$DOWNLOAD_URL" == "null" ]; then
    echo "[-] Failed to fetch 'ilow-backend' asset URL from repo '$REPO_SLUG'."
    echo "    Ensure GitHub Release exists with an uploaded 'ilow-backend' binary."
    exit 1
fi

curl -sL "$DOWNLOAD_URL" -o "$INSTALL_DIR/ilow-backend"
chmod +x "$INSTALL_DIR/ilow-backend"

echo "[+] Step 8: Generating secure .env configuration..."
cat <<EOF > "$INSTALL_DIR/.env"
PORT=${PORT}
DATABASE_URL=postgres://${DB_USER}:${DB_PASS}@localhost:5432/${DB_NAME}?sslmode=disable
ADMIN_API_KEY=${ADMIN_KEY}
EOF
chmod 600 "$INSTALL_DIR/.env"

echo "[+] Step 9: Creating and registering systemd service..."
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

echo "[+] Step 10: Enabling and starting service..."
systemctl daemon-reload
systemctl enable ilow-backend
systemctl restart ilow-backend

echo "[+] Deployment completed successfully!"
echo "--------------------------------------------------------"
echo " Service Status  : $(systemctl is-active ilow-backend)"
echo " Service Endpoint: http://localhost:${PORT}"
echo " Admin API Key   : ${ADMIN_KEY}"
echo "--------------------------------------------------------"