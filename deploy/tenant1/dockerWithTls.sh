#!/bin/bash
TLS_CERT_FILE="$(pwd)/clients/someuser/cert.pem"
TLS_KEY_FILE="$(pwd)/clients/someuser/key.pem"
TLS_CA_FILE="$(pwd)/clients/someuser/ca.pem"

exec docker --tls --tlsverify --tlskey "$TLS_KEY_FILE" --tlscert "$TLS_CERT_FILE" --tlscacert "$TLS_CA_FILE"  -H localhost:8081 "$@"