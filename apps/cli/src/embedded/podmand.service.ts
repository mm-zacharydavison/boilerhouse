/**
 * Systemd unit template for boilerhouse-podmand.
 * The binary path must be an absolute path to the installed boilerhouse binary.
 */
export function podmandServiceUnit(binaryPath: string, dataDir: string): string {
	return `[Unit]
Description=Boilerhouse Runtime Daemon (podman + CRIU)
After=network.target

[Service]
Type=simple
UMask=0117
EnvironmentFile=/etc/boilerhouse/podmand.env
ExecStartPre=/bin/mkdir -p /run/boilerhouse ${dataDir}/snapshots
ExecStart=${binaryPath} podmand start
ExecStartPost=/bin/sh -c 'until [ -S /run/boilerhouse/runtime.sock ]; do sleep 0.1; done; chgrp %i /run/boilerhouse/runtime.sock; chmod 660 /run/boilerhouse/runtime.sock'
Restart=on-failure
RestartSec=5

# Security hardening
CapabilityBoundingSet=CAP_SETUID CAP_SETGID CAP_SYS_PTRACE CAP_NET_ADMIN CAP_SYS_CHROOT CAP_CHOWN CAP_DAC_READ_SEARCH CAP_FOWNER CAP_KILL
ProtectSystem=strict
PrivateTmp=true
ReadWritePaths=/run/boilerhouse ${dataDir} /var/lib/containers /var/run/containers /tmp

[Install]
WantedBy=multi-user.target
`;
}
