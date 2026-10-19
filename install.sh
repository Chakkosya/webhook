#!/bin/sh
set -eu
project_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
docker compose -f "$project_dir/compose.yaml" pull
docker compose -f "$project_dir/compose.yaml" up -d --wait --wait-timeout 180
