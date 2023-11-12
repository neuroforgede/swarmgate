# Docker Swarm Multi-tenant Proxy

## Project Overview

This project implements a Docker Socket Proxy which is intended to give a tenant specific view onto a Docker Swarm. It exposes all necessary operations to deploy stacks with all features to Docker Swarm as well as management endpoints for volumes, secrets, configs, networks. 

All requests are filtered based on resource labels to check ownership of resources.

This projects uses Node.js and Express for the server, along with the dockerode (and docker-modem) library to interact with Docker.

## Features

- Multi-tenant Access Control: Restricts access to Docker Swarm resources based on ownership labels.
- Environment Variable Configuration: Uses environment variables to control various aspects like allowed volume drivers, volume types, and port exposure.
- Comprehensive API: Provides endpoints for managing Docker services, tasks, networks, secrets, configs, and volumes with ownership checks.
- Security Focused: Enforces checks on mount types, volume drivers, and ownership of resources like secrets and configs.

## Prerequisites

- Docker Swarm environment
- Access to Docker socket

## Installation

TODO: Docker installation instructions

## Usage:

```bash
DOCKER_API_VERSION=1.43 docker -H localhost:8080 info
```

## Environment Variables

- ALLOWED_REGULAR_VOLUMES_DRIVERS: Comma-separated list of allowed volume drivers.
- ALLOWED_VOLUME_TYPES: Comma-separated list of allowed volume types.
- ALLOW_PORT_EXPOSE: Set to 1 or true to allow port exposure.
- OWNER_LABEL_VALUE: Required value for the ownership label.

## Contributions

Contributions are welcome! Please fork the repository and submit pull requests with your changes. For major changes, please open an issue first to discuss what you would like to change.