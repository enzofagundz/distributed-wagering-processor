#!/bin/sh
set -eu
awslocal sqs create-queue --queue-name wagering-events
