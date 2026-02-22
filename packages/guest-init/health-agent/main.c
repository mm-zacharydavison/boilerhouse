/*
 * Boilerhouse health check agent.
 *
 * Runs inside the guest VM, periodically probes health, and reports the
 * result to the host via vsock. Supports two probe modes:
 *
 *   exec mode:  Fork+exec a command and check its exit code.
 *               Activated when command args are provided on argv.
 *               Usage: health-agent <command> [args...]
 *
 *   http mode:  Connect to localhost:<port>, send HTTP GET <path>,
 *               check for a 200 response status.
 *               Activated when BOILERHOUSE_HEALTH_HTTP_PORT is set.
 *
 * Configuration (env vars):
 *   BOILERHOUSE_HEALTH_VSOCK_PORT    — vsock port for reporting (required)
 *   BOILERHOUSE_HEALTH_INTERVAL      — seconds between checks (default: 5)
 *   BOILERHOUSE_HEALTH_CHECK_TIMEOUT — per-check timeout in seconds for exec mode (default: 60)
 *   BOILERHOUSE_HEALTH_HTTP_PORT     — HTTP probe target port (enables http mode)
 *   BOILERHOUSE_HEALTH_HTTP_PATH     — HTTP probe path (default: /)
 */

#define _GNU_SOURCE
#include <errno.h>
#include <netinet/in.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

/* vsock definitions — inlined to avoid dependency on linux/vm_sockets.h
 * which may not be available in musl cross-compilation environments. */
#ifndef AF_VSOCK
#define AF_VSOCK 40
#endif
#define VMADDR_CID_HOST 2

struct sockaddr_vm {
	unsigned short svm_family;
	unsigned short svm_reserved1;
	unsigned int svm_port;
	unsigned int svm_cid;
	unsigned char svm_zero[sizeof(struct sockaddr) -
	                       sizeof(unsigned short) -
	                       sizeof(unsigned short) -
	                       sizeof(unsigned int) -
	                       sizeof(unsigned int)];
};

#define DEFAULT_HEALTH_INTERVAL 5
#define DEFAULT_CHECK_TIMEOUT 60
#define HTTP_SOCKET_TIMEOUT_SECS 5

static volatile int running = 1;

static void handle_signal(int sig) {
	(void)sig;
	running = 0;
}

/* ── Exec probe ────────────────────────────────────────────────────────────── */

/*
 * Run the health check command and return its exit code.
 * Returns -1 on fork failure, -2 on timeout (child killed).
 *
 * Uses a non-blocking wait loop so a hanging check command (e.g. node
 * process stuck during startup) doesn't block the health-agent forever.
 */
static int check_timeout = DEFAULT_CHECK_TIMEOUT;

static int run_exec_check(char *const argv[]) {
	pid_t pid = fork();
	if (pid < 0) {
		fprintf(stderr, "health-agent: fork failed: %s\n", strerror(errno));
		return -1;
	}
	if (pid == 0) {
		execvp(argv[0], argv);
		_exit(127);
	}

	/* Poll with WNOHANG instead of blocking, so we can enforce a timeout. */
	for (int elapsed = 0; elapsed < check_timeout; elapsed++) {
		int status;
		pid_t result = waitpid(pid, &status, WNOHANG);
		if (result > 0) {
			if (WIFEXITED(status)) {
				return WEXITSTATUS(status);
			}
			if (WIFSIGNALED(status)) {
				return 128 + WTERMSIG(status);
			}
			return -1;
		}
		if (result < 0) {
			return -1;
		}
		/* Child still running — wait 1 second and retry. */
		sleep(1);
	}

	/* Timeout — kill the stuck child process. */
	fprintf(stderr, "health-agent: check timed out after %ds, killing pid %d\n",
	        check_timeout, pid);
	kill(pid, SIGKILL);
	waitpid(pid, NULL, 0);
	return -2;
}

/* ── HTTP probe ────────────────────────────────────────────────────────────── */

/*
 * Perform an HTTP GET to localhost:<port><path> and return 0 if the
 * response status is 200, non-zero otherwise. Uses blocking sockets
 * with SO_SNDTIMEO/SO_RCVTIMEO to bound the total time.
 */
static int run_http_check(int port, const char *path) {
	int fd = socket(AF_INET, SOCK_STREAM, 0);
	if (fd < 0) return -1;

	struct timeval tv = { .tv_sec = HTTP_SOCKET_TIMEOUT_SECS, .tv_usec = 0 };
	setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
	setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));

	struct sockaddr_in addr;
	memset(&addr, 0, sizeof(addr));
	addr.sin_family = AF_INET;
	addr.sin_port = htons((unsigned short)port);
	addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);

	if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
		close(fd);
		return -1;
	}

	char req[512];
	int reqlen = snprintf(req, sizeof(req),
		"GET %s HTTP/1.0\r\nHost: localhost\r\n\r\n", path);
	if (write(fd, req, (size_t)reqlen) != reqlen) {
		close(fd);
		return -1;
	}

	/* Read enough of the response to find the status code. */
	char resp[256];
	ssize_t n = read(fd, resp, sizeof(resp) - 1);
	close(fd);

	if (n <= 0) return -1;
	resp[n] = '\0';

	/* Match "HTTP/1.x 200" in the status line. */
	if (strstr(resp, " 200 ") != NULL) {
		return 0;
	}
	return 1;
}

/* ── Vsock reporting ───────────────────────────────────────────────────────── */

/* Track repeated vsock errors to avoid spamming the console. */
static int vsock_error_count = 0;
#define VSOCK_ERROR_LOG_INTERVAL 10

/* Report health status over vsock (AF_VSOCK, CID=2 = host). */
static void report_vsock(unsigned int port, int exit_code) {
	int fd = socket(AF_VSOCK, SOCK_STREAM, 0);
	if (fd < 0) {
		if (vsock_error_count++ % VSOCK_ERROR_LOG_INTERVAL == 0) {
			fprintf(stderr, "health-agent: socket(AF_VSOCK) failed: %s (count=%d)\n",
			        strerror(errno), vsock_error_count);
		}
		return;
	}

	struct sockaddr_vm addr;
	memset(&addr, 0, sizeof(addr));
	addr.svm_family = AF_VSOCK;
	addr.svm_cid = VMADDR_CID_HOST;
	addr.svm_port = port;

	if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
		if (vsock_error_count++ % VSOCK_ERROR_LOG_INTERVAL == 0) {
			fprintf(stderr, "health-agent: vsock connect(CID=%d, port=%u) failed: %s (count=%d)\n",
			        VMADDR_CID_HOST, port, strerror(errno), vsock_error_count);
		}
		close(fd);
		return;
	}

	vsock_error_count = 0;

	char buf[64];
	int len;
	if (exit_code == 0) {
		len = snprintf(buf, sizeof(buf), "HEALTH OK\n");
	} else {
		len = snprintf(buf, sizeof(buf), "HEALTH FAIL %d\n", exit_code);
	}
	if (len > 0) {
		ssize_t written = write(fd, buf, (size_t)len);
		(void)written;
	}
	close(fd);
}

/* ── Main ──────────────────────────────────────────────────────────────────── */

int main(int argc, char *argv[]) {
	/* Install signal handlers. */
	struct sigaction sa;
	memset(&sa, 0, sizeof(sa));
	sa.sa_handler = handle_signal;
	sa.sa_flags = 0;
	sigaction(SIGTERM, &sa, NULL);
	sigaction(SIGINT, &sa, NULL);

	/* Parse configuration from environment. */
	const char *port_str = getenv("BOILERHOUSE_HEALTH_VSOCK_PORT");
	const char *interval_str = getenv("BOILERHOUSE_HEALTH_INTERVAL");
	const char *timeout_str = getenv("BOILERHOUSE_HEALTH_CHECK_TIMEOUT");
	const char *http_port_str = getenv("BOILERHOUSE_HEALTH_HTTP_PORT");
	const char *http_path_str = getenv("BOILERHOUSE_HEALTH_HTTP_PATH");

	if (!port_str) {
		fprintf(stderr, "health-agent: BOILERHOUSE_HEALTH_VSOCK_PORT not set\n");
		return 1;
	}

	unsigned int vsock_port = (unsigned int)atoi(port_str);
	if (vsock_port == 0) {
		fprintf(stderr, "health-agent: invalid BOILERHOUSE_HEALTH_VSOCK_PORT\n");
		return 1;
	}

	int interval = DEFAULT_HEALTH_INTERVAL;
	if (interval_str) {
		int v = atoi(interval_str);
		if (v > 0) interval = v;
	}

	if (timeout_str) {
		int v = atoi(timeout_str);
		if (v > 0) check_timeout = v;
	}

	/* Determine probe mode. */
	int mode_http = 0;
	int http_port = 0;
	const char *http_path = "/";
	char **cmd_argv = NULL;

	if (http_port_str) {
		http_port = atoi(http_port_str);
		if (http_port <= 0) {
			fprintf(stderr, "health-agent: invalid BOILERHOUSE_HEALTH_HTTP_PORT\n");
			return 1;
		}
		if (http_path_str && http_path_str[0] != '\0') {
			http_path = http_path_str;
		}
		mode_http = 1;
	} else if (argc >= 2) {
		cmd_argv = &argv[1];
	} else {
		fprintf(stderr, "usage: health-agent <command> [args...]\n");
		fprintf(stderr, "   or: set BOILERHOUSE_HEALTH_HTTP_PORT for http mode\n");
		return 1;
	}

	if (mode_http) {
		fprintf(stderr, "health-agent: started http mode (port=%u interval=%ds "
		        "target=localhost:%d%s)\n",
		        vsock_port, interval, http_port, http_path);
	} else {
		fprintf(stderr, "health-agent: started exec mode (port=%u interval=%ds "
		        "check_timeout=%ds cmd=%s)\n",
		        vsock_port, interval, check_timeout, cmd_argv[0]);
	}

	/* Main health check loop. */
	int check_count = 0;
	while (running) {
		int exit_code;
		if (mode_http) {
			exit_code = run_http_check(http_port, http_path);
		} else {
			exit_code = run_exec_check(cmd_argv);
		}
		check_count++;
		if (exit_code != 0 && check_count <= 3) {
			fprintf(stderr, "health-agent: check #%d exit_code=%d\n",
			        check_count, exit_code);
		}
		report_vsock(vsock_port, exit_code);

		/* Sleep in 1-second intervals for responsive SIGTERM handling. */
		for (int i = 0; i < interval && running; i++) {
			sleep(1);
		}
	}

	return 0;
}
