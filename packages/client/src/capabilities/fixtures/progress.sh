#!/bin/sh
set -eu

IFS= read -r request

if [ "${ALLINAI_SECRET_FOR_TEST:-}" != "" ]; then
  printf '%s\n' '{"type":"error","payload":{"reason":"ambient_environment_leaked"}}'
  exit 1
fi

if [ "$request" != '{"input":{"branch":"main"},"context":{"workspace":"/tmp/work"}}' ]; then
  printf '%s\n' '{"type":"error","payload":{"reason":"stdin_document_mismatch"}}'
  exit 1
fi

printf '%s\n' '{"type":"progress","payload":{"phase":"started"}}'
printf '%s\n' '{"type":"result","payload":{"published":true}}'
