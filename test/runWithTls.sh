#!/bin/bash

export TLS_CERT_FILE="$(pwd)/server-cert.pem"
export TLS_KEY_FILE="$(pwd)/server-key.pem"
export TLS_CA_FILE="$(pwd)/ca-cert.pem"

cd ../swarmgate
exec npm run run-dev