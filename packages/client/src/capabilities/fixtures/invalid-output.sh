#!/bin/sh
set -eu

IFS= read -r ignored
printf '%s\n' 'this is not a JSONL capability frame'
