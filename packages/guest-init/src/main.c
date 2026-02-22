/*
 * Boilerhouse PID 1 init for microVMs.
 *
 * Responsibilities:
 *   - Mount essential filesystems (/proc, /sys, /dev, /dev/pts, /tmp)
 *   - Open /dev/console for stdio
 *   - Fork the idle-agent (if present)
 *   - Fork the health-agent (if health command provided via --- separator)
 *   - Fork the entrypoint (from argv, fallback /bin/sh)
 *   - Forward SIGTERM/SIGINT/SIGHUP to the entrypoint child
 *   - Reap zombies; exit with the entrypoint's exit code
 *
 * Argv convention:
 *   init [entrypoint args...] [-- entrypoint_cmd args] [--- health_cmd args]
 *   The `---` separator splits argv into entrypoint (before) and health
 *   check command (after). Health agent configuration is read from kernel
 *   cmdline params: boilerhouse.health_port and boilerhouse.health_interval.
 */

#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

/* RNDADDTOENTCNT from <linux/random.h> — inlined for musl portability. */
#ifndef RNDADDTOENTCNT
#define RNDADDTOENTCNT _IOW('R', 0x01, int)
#endif

#define IDLE_AGENT_PATH "/opt/boilerhouse/idle-agent"
#define HEALTH_AGENT_PATH "/opt/boilerhouse/health-agent"
#define CMDLINE_PATH "/proc/cmdline"
#define CMDLINE_MAX 4096

/* PID of the entrypoint child — used by signal handler. */
static volatile pid_t entrypoint_pid = -1;

static void forward_signal(int sig) {
	if (entrypoint_pid > 0) {
		kill(entrypoint_pid, sig);
	}
}

static void mount_fs(const char *source, const char *target,
                     const char *fstype, unsigned long flags) {
	struct stat st;
	if (stat(target, &st) != 0) {
		mkdir(target, 0755);
	}
	if (mount(source, target, fstype, flags, NULL) != 0) {
		fprintf(stderr, "init: mount %s on %s failed: %s\n",
		        fstype, target, strerror(errno));
	}
}

/*
 * Read a `name=value` parameter from /proc/cmdline.
 * Returns a strdup'd value string, or NULL if not found.
 */
static char *parse_cmdline_param(const char *name) {
	FILE *f = fopen(CMDLINE_PATH, "r");
	if (!f) return NULL;

	char buf[CMDLINE_MAX];
	if (!fgets(buf, sizeof(buf), f)) {
		fclose(f);
		return NULL;
	}
	fclose(f);

	size_t name_len = strlen(name);
	char *p = buf;
	while (*p) {
		/* Skip whitespace. */
		while (*p == ' ' || *p == '\t' || *p == '\n') p++;
		if (!*p) break;

		/* Check if this token starts with name= */
		if (strncmp(p, name, name_len) == 0 && p[name_len] == '=') {
			char *val = p + name_len + 1;
			/* Find end of value (next whitespace or end of string). */
			char *end = val;
			while (*end && *end != ' ' && *end != '\t' && *end != '\n') end++;
			*end = '\0';
			return strdup(val);
		}

		/* Skip to next whitespace. */
		while (*p && *p != ' ' && *p != '\t' && *p != '\n') p++;
	}
	return NULL;
}

/*
 * Seed the kernel CRNG to unblock getrandom(2).
 *
 * MicroVMs without a hardware RNG (Firecracker doesn't support virtio-rng)
 * may never accumulate enough entropy from interrupts alone. Without this,
 * any process calling getrandom() (e.g. Node.js / V8 CSPRNG init) blocks
 * indefinitely.
 *
 * We mix in the best available data (timestamps, addresses, boot_id) and
 * credit the entropy pool so the CRNG initializes. On kernels >= 5.6 this
 * is unnecessary (jitter entropy + trust_cpu), but older kernels (4.14)
 * used by Firecracker need it.
 */
static void seed_rng(void) {
	struct {
		struct timespec mono;
		struct timespec real;
		pid_t pid;
		void *stack_addr;
	} seed;

	clock_gettime(CLOCK_MONOTONIC, &seed.mono);
	clock_gettime(CLOCK_REALTIME, &seed.real);
	seed.pid = getpid();
	seed.stack_addr = &seed;

	int fd = open("/dev/urandom", O_WRONLY);
	if (fd >= 0) {
		write(fd, &seed, sizeof(seed));
		close(fd);
	}

	/* Credit entropy so the CRNG marks itself as initialized. */
	fd = open("/dev/random", O_RDWR);
	if (fd >= 0) {
		int bits = 256;
		ioctl(fd, RNDADDTOENTCNT, &bits);
		close(fd);
	}
}

static void setup_console(void) {
	int fd = open("/dev/console", O_RDWR);
	if (fd >= 0) {
		dup2(fd, STDIN_FILENO);
		dup2(fd, STDOUT_FILENO);
		dup2(fd, STDERR_FILENO);
		if (fd > STDERR_FILENO)
			close(fd);
	}
}

static void setup_mounts(void) {
	mount_fs("proc",    "/proc",   "proc",     MS_NOSUID | MS_NODEV | MS_NOEXEC);
	mount_fs("sysfs",   "/sys",    "sysfs",    MS_NOSUID | MS_NODEV | MS_NOEXEC);
	mount_fs("devtmpfs","/dev",    "devtmpfs", MS_NOSUID);
	mount_fs("devpts",  "/dev/pts","devpts",   MS_NOSUID | MS_NOEXEC);
	mount_fs("tmpfs",   "/tmp",    "tmpfs",    MS_NOSUID | MS_NODEV);
}

static pid_t spawn(char *const argv[]) {
	pid_t pid = fork();
	if (pid < 0) {
		fprintf(stderr, "init: fork failed: %s\n", strerror(errno));
		return -1;
	}
	if (pid == 0) {
		/* Create a new session so the child has its own process group. */
		setsid();
		execvp(argv[0], argv);
		fprintf(stderr, "init: exec %s failed: %s\n", argv[0], strerror(errno));
		_exit(127);
	}
	return pid;
}

int main(int argc, char *argv[]) {
	/* Only set up mounts and console when running as actual PID 1. */
	if (getpid() == 1) {
		setup_mounts();
		setup_console();
		seed_rng();
	}

	/*
	 * Set a sane default PATH. Container images (e.g. node:22-bookworm)
	 * install binaries under /usr/local/bin, which isn't in the default
	 * execvp search path. Without this, `execvp("node", ...)` fails.
	 */
	setenv("PATH", "/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin", 0);

	/*
	 * Change working directory if specified via kernel cmdline.
	 * Corresponds to the container image's WORKDIR (e.g. /app).
	 */
	char *workdir = parse_cmdline_param("boilerhouse.workdir");
	if (workdir) {
		if (chdir(workdir) != 0) {
			fprintf(stderr, "init: chdir(%s) failed: %s\n", workdir, strerror(errno));
		} else {
			fprintf(stderr, "init: workdir=%s\n", workdir);
		}
		free(workdir);
	}

	/* Install signal handlers to forward to entrypoint child. */
	struct sigaction sa;
	memset(&sa, 0, sizeof(sa));
	sa.sa_handler = forward_signal;
	sa.sa_flags = SA_RESTART;
	sigaction(SIGTERM, &sa, NULL);
	sigaction(SIGINT, &sa, NULL);
	sigaction(SIGHUP, &sa, NULL);

	/* Scan for `---` separator to split entrypoint vs health command. */
	int health_start = 0;
	for (int i = 1; i < argc; i++) {
		if (strcmp(argv[i], "---") == 0) {
			health_start = i + 1;
			argv[i] = NULL; /* Terminate entrypoint argv at the separator. */
			break;
		}
	}

	/* Fork idle-agent if it exists. */
	struct stat agent_stat;
	if (stat(IDLE_AGENT_PATH, &agent_stat) == 0) {
		char *agent_argv[] = { IDLE_AGENT_PATH, NULL };
		pid_t agent = spawn(agent_argv);
		if (agent < 0) {
			fprintf(stderr, "init: warning: failed to spawn idle-agent\n");
		}
	}

	/*
	 * Fork health-agent if health config is present in kernel cmdline.
	 * The agent supports two modes:
	 *   - exec mode:  when a --- separator provides a command (argv)
	 *   - http mode:  when boilerhouse.health_http_port is set (env var)
	 */
	char *health_port = parse_cmdline_param("boilerhouse.health_port");
	if (health_port) {
		struct stat health_stat;
		if (stat(HEALTH_AGENT_PATH, &health_stat) == 0) {
			char *interval = parse_cmdline_param("boilerhouse.health_interval");
			char *check_timeout = parse_cmdline_param("boilerhouse.health_check_timeout");
			char *h_http_port = parse_cmdline_param("boilerhouse.health_http_port");
			char *h_http_path = parse_cmdline_param("boilerhouse.health_http_path");

			fprintf(stderr, "init: health config: port=%s interval=%s",
			        health_port, interval ? interval : "(null)");
			if (h_http_port) {
				fprintf(stderr, " http=%s:%s\n",
				        h_http_port, h_http_path ? h_http_path : "/");
			} else {
				fprintf(stderr, " check_timeout=%s\n",
				        check_timeout ? check_timeout : "(null)");
			}

			setenv("BOILERHOUSE_HEALTH_VSOCK_PORT", health_port, 1);
			if (interval) setenv("BOILERHOUSE_HEALTH_INTERVAL", interval, 1);
			if (check_timeout) setenv("BOILERHOUSE_HEALTH_CHECK_TIMEOUT", check_timeout, 1);
			if (h_http_port) setenv("BOILERHOUSE_HEALTH_HTTP_PORT", h_http_port, 1);
			if (h_http_path) setenv("BOILERHOUSE_HEALTH_HTTP_PATH", h_http_path, 1);

			pid_t health_pid;
			if (health_start > 0 && health_start < argc) {
				/* Exec mode: pass command args after health-agent. */
				int health_argc = argc - health_start;
				char **health_argv = malloc((size_t)(health_argc + 2) * sizeof(char *));
				if (health_argv) {
					health_argv[0] = HEALTH_AGENT_PATH;
					for (int i = 0; i < health_argc; i++) {
						health_argv[i + 1] = argv[health_start + i];
					}
					health_argv[health_argc + 1] = NULL;
					fprintf(stderr, "init: forking health-agent (exec): %s %s\n",
					        health_argv[0], health_argc > 0 ? health_argv[1] : "");
					health_pid = spawn(health_argv);
					free(health_argv);
				} else {
					health_pid = -1;
				}
			} else {
				/* HTTP mode: health-agent with no command args. */
				char *health_argv[] = { HEALTH_AGENT_PATH, NULL };
				fprintf(stderr, "init: forking health-agent (http)\n");
				health_pid = spawn(health_argv);
			}

			if (health_pid < 0) {
				fprintf(stderr, "init: warning: failed to spawn health-agent\n");
			} else {
				fprintf(stderr, "init: health-agent pid=%d\n", health_pid);
			}

			free(interval);
			free(check_timeout);
			free(h_http_port);
			free(h_http_path);
		} else {
			fprintf(stderr, "init: warning: health config present but %s not found\n",
			        HEALTH_AGENT_PATH);
		}
		free(health_port);
	}

	/* Build entrypoint argv. */
	char *default_argv[] = { "/bin/sh", NULL };
	char **entry_argv;
	if (argc > 1 && argv[1] != NULL) {
		entry_argv = &argv[1];
	} else {
		entry_argv = default_argv;
	}

	/* Fork entrypoint. */
	fprintf(stderr, "init: exec entrypoint: %s\n", entry_argv[0]);
	entrypoint_pid = spawn(entry_argv);
	if (entrypoint_pid < 0) {
		fprintf(stderr, "init: failed to spawn entrypoint\n");
		return 1;
	}

	/* Reap loop: wait for all children, track entrypoint exit code. */
	int entrypoint_status = 0;
	int entrypoint_exited = 0;
	while (1) {
		int status;
		pid_t pid = waitpid(-1, &status, 0);
		if (pid < 0) {
			if (errno == ECHILD) {
				break; /* No more children. */
			}
			continue;
		}
		if (pid == entrypoint_pid) {
			if (WIFEXITED(status)) {
				entrypoint_status = WEXITSTATUS(status);
				fprintf(stderr, "init: entrypoint exited with code %d\n", entrypoint_status);
			} else if (WIFSIGNALED(status)) {
				entrypoint_status = 128 + WTERMSIG(status);
				fprintf(stderr, "init: entrypoint killed by signal %d\n", WTERMSIG(status));
			}
			entrypoint_exited = 1;
			/*
			 * Once the entrypoint exits, terminate any remaining children
			 * (e.g., idle-agent) so we can clean up.
			 */
			kill(-1, SIGTERM);
		}
		/* If entrypoint already exited and no children remain, we're done. */
		if (entrypoint_exited) {
			/* Check if there are more children before breaking. */
			pid_t check = waitpid(-1, &status, WNOHANG);
			if (check <= 0) {
				break;
			}
			/* Reap this one too. */
			if (check == entrypoint_pid) {
				/* Shouldn't happen, but handle it. */
			}
		}
	}

	return entrypoint_status;
}
