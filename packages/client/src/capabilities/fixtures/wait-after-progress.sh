#!/bin/sh
set -eu

IFS= read -r ignored
printf '%s\n' '{"type":"progress","payload":{"phase":"waiting"}}'
sleep 30
