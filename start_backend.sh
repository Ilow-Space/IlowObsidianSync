#!/usr/bin/env bash
set -e

TMP_DIR="/tmp/pg_embedded_test"
PG_PORT=5433
GO_PORT=3001

if [ ! -d "/tmp/pg_embedded/bin" ]; then
    echo "Downloading embedded PostgreSQL 15..."
    python3 -c "
import urllib.request, zipfile, io
url = 'https://repo1.maven.org/maven2/io/zonky/test/postgres/embedded-postgres-binaries-linux-amd64/15.3.0/embedded-postgres-binaries-linux-amd64-15.3.0.jar'
data = urllib.request.urlopen(url).read()
z = zipfile.ZipFile(io.BytesIO(data))
txz_data = z.read('postgres-linux-x86_64.txz')
with open('/tmp/pg.txz', 'wb') as f:
    f.write(txz_data)
"
    mkdir -p /tmp/pg_embedded
    tar -xJ -f /tmp/pg.txz -C /tmp/pg_embedded
fi

export PATH="/tmp/pg_embedded/bin:$PATH"

if [ ! -d "$TMP_DIR/data" ]; then
    echo "Initializing DB..."
    mkdir -p "$TMP_DIR/data"
    initdb -D "$TMP_DIR/data" -U postgres --auth=trust
fi

if ! pg_ctl -D "$TMP_DIR/data" status >/dev/null 2>&1; then
    echo "Starting PostgreSQL on port $PG_PORT..."
    pg_ctl -D "$TMP_DIR/data" -l "$TMP_DIR/postgres.log" -o "-p $PG_PORT" start
    sleep 2
fi

# Ensure database ilow_sync exists by running init script in Go
cat << 'GOEOF' > /tmp/create_db.go
package main
import (
	"database/sql"
	"fmt"
	_ "github.com/lib/pq"
)
func main() {
	db, err := sql.Open("postgres", "postgres://postgres@localhost:5433/postgres?sslmode=disable")
	if err != nil { panic(err) }
	defer db.Close()
	_, err = db.Exec("CREATE DATABASE ilow_sync;")
	if err != nil { fmt.Println("Create DB:", err) } else { fmt.Println("ilow_sync created.") }
}
GOEOF

(cd backend && go run /tmp/create_db.go) || true

cd backend
export PORT=$GO_PORT
export DATABASE_URL="postgres://postgres@localhost:$PG_PORT/ilow_sync?sslmode=disable"
export ADMIN_API_KEY="A547245O7B57F75A7U7B4F7U57I75E7D27b4A5U75IEFBaszsjbuif32772525b?"

echo "Building and starting Go backend on port $GO_PORT..."
exec go run main.go
