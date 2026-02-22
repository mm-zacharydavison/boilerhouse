FROM alpine:3.21

# Minimal init so Firecracker has a PID 1
RUN apk add --no-cache busybox-openrc openrc \
    && mkdir -p /run/openrc \
    && touch /run/openrc/softlevel

CMD ["/sbin/init"]
