#!/bin/bash
TLS_CERT_FILE="$(pwd)/client-cert.pem"
TLS_KEY_FILE="$(pwd)/client-key.pem"
TLS_CA_FILE="$(pwd)/ca-cert.pem"

exec docker --tls --tlsverify --tlskey "$TLS_KEY_FILE" --tlscert "$TLS_CERT_FILE" --tlscacert "$TLS_CA_FILE"  -H localhost:8080 "$@"