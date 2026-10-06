/*
 * openleaf-sandbox: start a program with less reach than the process that started it.
 *
 *   openleaf-sandbox [--ro PATH]... [--rw PATH]... -- program [args...]
 *   openleaf-sandbox --probe
 *
 * OpenLeaf compiles documents that it has to treat as untrusted input, and LaTeX is a
 * programming language. Namespaces would keep a compile apart from the service, but many
 * container hosts do not allow them. This launcher uses two kernel facilities that an
 * ordinary user may always apply to itself, so they work on those hosts too:
 *
 *   seccomp   A list of system calls that the program, and everything it starts, is refused:
 *             opening a socket of any kind (so: no network), looking into or controlling
 *             another process, leaving the process group it was started in, and a handful of
 *             kernel facilities a TeX run never needs. Always applied.
 *
 *   Landlock  When --ro / --rw paths are given: the program can read and run what is under
 *             the --ro paths, read and write (but not run, and not make links in) what is
 *             under the --rw paths, and nothing else in the file system. Where the kernel is
 *             new enough it also cannot signal processes outside itself.
 *
 * Both are inherited by every process the program starts and cannot be taken off again.
 * If a restriction that was asked for cannot be applied, the program is not started.
 *
 * --probe prints what this kernel supports as one line of JSON, after trying each for real
 * in a child process:  {"seccomp":true,"landlock":6}
 *
 * Build:  cc -O2 -Wall -Wextra -static -o openleaf-sandbox sandbox.c
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>

#define NAME "openleaf-sandbox"
#define EXIT_SETUP 126 /* a restriction could not be applied; the program was not started */

/* ------------------------------------------------------------------ seccomp */

#if defined(__x86_64__)
#define ARCH_NATIVE AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define ARCH_NATIVE AUDIT_ARCH_AARCH64
#endif

#ifndef SECCOMP_RET_KILL_PROCESS
#define SECCOMP_RET_KILL_PROCESS 0x80000000U
#endif

#ifdef ARCH_NATIVE
/* What is refused, and the error the caller gets. Everything else is allowed. */
static const struct {
  long nr;
  int err;
} refused[] = {
  /* No network: a socket of any family. (Pipes and socketpair are not sockets to anywhere.) */
  {__NR_socket, EACCES},
#ifdef __NR_io_uring_setup
  /* io_uring can open sockets without the socket call; programs fall back when it is absent. */
  {__NR_io_uring_setup, ENOSYS},
#endif

  /* No looking into, or steering, another process. */
  {__NR_ptrace, EPERM},
  {__NR_process_vm_readv, EPERM},
  {__NR_process_vm_writev, EPERM},
#ifdef __NR_pidfd_getfd
  {__NR_pidfd_getfd, EPERM},
#endif
#ifdef __NR_kcmp
  {__NR_kcmp, EPERM},
#endif

  /* Stay in the process group it was started in, so the whole run can be ended together. */
  {__NR_setsid, EPERM},
  {__NR_setpgid, EPERM},

  /* Kernel facilities a TeX run has no use for. */
  {__NR_bpf, EPERM},
  {__NR_perf_event_open, EPERM},
#ifdef __NR_userfaultfd
  {__NR_userfaultfd, EPERM},
#endif
  {__NR_keyctl, EPERM},
  {__NR_add_key, EPERM},
  {__NR_request_key, EPERM},
  {__NR_mount, EPERM},
  {__NR_umount2, EPERM},
  {__NR_pivot_root, EPERM},
  {__NR_chroot, EPERM},
  {__NR_unshare, EPERM},
  {__NR_setns, EPERM},
#ifdef __NR_open_tree
  {__NR_open_tree, EPERM},
#endif
#ifdef __NR_move_mount
  {__NR_move_mount, EPERM},
#endif
#ifdef __NR_fsopen
  {__NR_fsopen, EPERM},
#endif
#ifdef __NR_fsconfig
  {__NR_fsconfig, EPERM},
#endif
#ifdef __NR_fsmount
  {__NR_fsmount, EPERM},
#endif
#ifdef __NR_fspick
  {__NR_fspick, EPERM},
#endif
#ifdef __NR_mount_setattr
  {__NR_mount_setattr, EPERM},
#endif
};

#define N_REFUSED (sizeof(refused) / sizeof(refused[0]))

static int apply_seccomp(void) {
  struct sock_filter f[8 + 2 * N_REFUSED];
  size_t n = 0;

  /* A program built for another architecture numbers its system calls differently and
     would slip past a list of numbers, so it is not allowed to run at all. */
  f[n++] = (struct sock_filter)BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch));
  f[n++] = (struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, ARCH_NATIVE, 1, 0);
  f[n++] = (struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS);

  f[n++] = (struct sock_filter)BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr));
#if defined(__x86_64__)
  /* The x32 variant of each call has the same number with this bit set. */
  f[n++] = (struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JGE | BPF_K, 0x40000000U, 0, 1);
  f[n++] = (struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | ENOSYS);
#endif
  for (size_t i = 0; i < N_REFUSED; i++) {
    f[n++] = (struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (uint32_t)refused[i].nr, 0, 1);
    f[n++] = (struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (uint32_t)refused[i].err);
  }
  f[n++] = (struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW);

  struct sock_fprog prog = {.len = (unsigned short)n, .filter = f};
  if (syscall(SYS_seccomp, SECCOMP_SET_MODE_FILTER, 0, &prog) == 0) return 0;
  return prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &prog);
}
#else
static int apply_seccomp(void) {
  errno = ENOSYS;
  return -1;
}
#endif

/* ----------------------------------------------------------------- Landlock */
/* Declared here rather than taken from <linux/landlock.h>, so that the build does not depend
   on how new the installed kernel headers are. The numbers are part of the kernel's ABI. */

#ifndef __NR_landlock_create_ruleset
#define __NR_landlock_create_ruleset 444
#define __NR_landlock_add_rule 445
#define __NR_landlock_restrict_self 446
#endif

struct ll_ruleset_attr {
  uint64_t handled_access_fs;
  uint64_t handled_access_net; /* ABI 4 */
  uint64_t scoped;             /* ABI 6 */
};

struct ll_path_beneath_attr {
  uint64_t allowed_access;
  int32_t parent_fd;
} __attribute__((packed));

#define LL_CREATE_RULESET_VERSION (1U << 0)
#define LL_RULE_PATH_BENEATH 1

#define LL_FS_EXECUTE (1ULL << 0)
#define LL_FS_WRITE_FILE (1ULL << 1)
#define LL_FS_READ_FILE (1ULL << 2)
#define LL_FS_READ_DIR (1ULL << 3)
#define LL_FS_REMOVE_DIR (1ULL << 4)
#define LL_FS_REMOVE_FILE (1ULL << 5)
#define LL_FS_MAKE_CHAR (1ULL << 6)
#define LL_FS_MAKE_DIR (1ULL << 7)
#define LL_FS_MAKE_REG (1ULL << 8)
#define LL_FS_MAKE_SOCK (1ULL << 9)
#define LL_FS_MAKE_FIFO (1ULL << 10)
#define LL_FS_MAKE_BLOCK (1ULL << 11)
#define LL_FS_MAKE_SYM (1ULL << 12)
#define LL_FS_REFER (1ULL << 13)     /* ABI 2 */
#define LL_FS_TRUNCATE (1ULL << 14)  /* ABI 3 */
#define LL_FS_IOCTL_DEV (1ULL << 15) /* ABI 5 */

#define LL_NET_BIND_TCP (1ULL << 0)
#define LL_NET_CONNECT_TCP (1ULL << 1)

#define LL_SCOPE_ABSTRACT_UNIX_SOCKET (1ULL << 0)
#define LL_SCOPE_SIGNAL (1ULL << 1)

/* Rights that make sense on a single file (as opposed to a directory). */
#define LL_FS_FILE_RIGHTS (LL_FS_EXECUTE | LL_FS_WRITE_FILE | LL_FS_READ_FILE | LL_FS_TRUNCATE | LL_FS_IOCTL_DEV)

static long landlock_abi(void) {
  long v = syscall(__NR_landlock_create_ruleset, NULL, 0, LL_CREATE_RULESET_VERSION);
  return v < 0 ? 0 : v;
}

static uint64_t fs_handled(long abi) {
  uint64_t all = LL_FS_EXECUTE | LL_FS_WRITE_FILE | LL_FS_READ_FILE | LL_FS_READ_DIR | LL_FS_REMOVE_DIR |
                 LL_FS_REMOVE_FILE | LL_FS_MAKE_CHAR | LL_FS_MAKE_DIR | LL_FS_MAKE_REG | LL_FS_MAKE_SOCK |
                 LL_FS_MAKE_FIFO | LL_FS_MAKE_BLOCK | LL_FS_MAKE_SYM;
  if (abi >= 2) all |= LL_FS_REFER;
  if (abi >= 3) all |= LL_FS_TRUNCATE;
  if (abi >= 5) all |= LL_FS_IOCTL_DEV;
  return all;
}

/* Read and run. */
static uint64_t fs_ro(void) { return LL_FS_EXECUTE | LL_FS_READ_FILE | LL_FS_READ_DIR; }

/* Read and write, make and remove files and folders. Not: run a file from here, or make
   links, devices or sockets in it. */
static uint64_t fs_rw(long abi) {
  uint64_t r = LL_FS_READ_FILE | LL_FS_READ_DIR | LL_FS_WRITE_FILE | LL_FS_REMOVE_DIR | LL_FS_REMOVE_FILE |
               LL_FS_MAKE_DIR | LL_FS_MAKE_REG;
  if (abi >= 2) r |= LL_FS_REFER;
  if (abi >= 3) r |= LL_FS_TRUNCATE;
  if (abi >= 5) r |= LL_FS_IOCTL_DEV; /* /dev/null and the like, when listed */
  return r;
}

static int ll_create(long abi) {
  struct ll_ruleset_attr attr = {0};
  attr.handled_access_fs = fs_handled(abi);
  size_t size = sizeof(uint64_t);
  if (abi >= 4) {
    attr.handled_access_net = LL_NET_BIND_TCP | LL_NET_CONNECT_TCP;
    size = 2 * sizeof(uint64_t);
  }
  if (abi >= 6) {
    attr.scoped = LL_SCOPE_ABSTRACT_UNIX_SOCKET | LL_SCOPE_SIGNAL;
    size = 3 * sizeof(uint64_t);
  }
  return (int)syscall(__NR_landlock_create_ruleset, &attr, size, 0);
}

/* Allow `access` beneath `path`. A path that does not exist is skipped: nothing is there to
   allow. Returns -1 only when the rule itself was refused. */
static int ll_allow(int ruleset, const char *path, uint64_t access, uint64_t handled) {
  int fd = open(path, O_PATH | O_CLOEXEC);
  if (fd < 0) return 0;

  /* On a single file only the file rights may be named. */
  int dirfd = open(path, O_PATH | O_DIRECTORY | O_CLOEXEC);
  if (dirfd < 0) access &= LL_FS_FILE_RIGHTS;
  else close(dirfd);

  struct ll_path_beneath_attr rule = {.allowed_access = access & handled, .parent_fd = fd};
  int rc = 0;
  if (rule.allowed_access != 0) rc = (int)syscall(__NR_landlock_add_rule, ruleset, LL_RULE_PATH_BENEATH, &rule, 0);
  close(fd);
  return rc;
}

/* ------------------------------------------------------------------- probe */

/* Run `check` in a child and report whether it returned 0. */
static int in_child(int (*check)(void)) {
  pid_t pid = fork();
  if (pid < 0) return 0;
  if (pid == 0) _exit(check() == 0 ? 0 : 1);
  int status = 0;
  if (waitpid(pid, &status, 0) < 0) return 0;
  return WIFEXITED(status) && WEXITSTATUS(status) == 0;
}

/* After the filter is on, asking for a socket must be refused. */
static int check_seccomp(void) {
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) return -1;
  if (apply_seccomp() != 0) return -1;
  int s = socket(AF_INET, SOCK_STREAM, 0);
  if (s >= 0) return -1;
  return errno == EACCES ? 0 : -1;
}

/* After a rule set that allows nothing is on, opening a folder must be refused. */
static int check_landlock(void) {
  long abi = landlock_abi();
  if (abi < 1) return -1;
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) return -1;
  int ruleset = ll_create(abi);
  if (ruleset < 0) return -1;
  if (syscall(__NR_landlock_restrict_self, ruleset, 0) != 0) return -1;
  int fd = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (fd >= 0) return -1;
  return errno == EACCES ? 0 : -1;
}

static int probe(void) {
  int seccomp = in_child(check_seccomp);
  long abi = in_child(check_landlock) ? landlock_abi() : 0;
  printf("{\"seccomp\":%s,\"landlock\":%ld}\n", seccomp ? "true" : "false", abi);
  return 0;
}

/* -------------------------------------------------------------------- main */

static void fail(const char *what) {
  fprintf(stderr, NAME ": %s: %s\n", what, strerror(errno));
  exit(EXIT_SETUP);
}

static void usage(void) {
  fputs("usage: " NAME " [--ro PATH]... [--rw PATH]... -- program [args...]\n"
        "       " NAME " --probe\n",
        stderr);
  exit(2);
}

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--probe") == 0) return probe();

  const char **ro = calloc((size_t)argc, sizeof(char *));
  const char **rw = calloc((size_t)argc, sizeof(char *));
  if (!ro || !rw) fail("out of memory");
  size_t n_ro = 0, n_rw = 0;

  int i = 1;
  for (; i < argc; i++) {
    if (strcmp(argv[i], "--") == 0) {
      i++;
      break;
    }
    if (strcmp(argv[i], "--ro") == 0 && i + 1 < argc) ro[n_ro++] = argv[++i];
    else if (strcmp(argv[i], "--rw") == 0 && i + 1 < argc) rw[n_rw++] = argv[++i];
    else usage();
  }
  if (i >= argc) usage();

  /* Needed for both restrictions, and good in itself: no gaining privileges through
     set-uid programs from here on. */
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) fail("cannot set no-new-privileges");

  if (n_ro + n_rw > 0) {
    long abi = landlock_abi();
    if (abi < 1) {
      errno = ENOSYS;
      fail("file restrictions were asked for, but this kernel has no Landlock");
    }
    int ruleset = ll_create(abi);
    if (ruleset < 0) fail("cannot create the file rule set");
    uint64_t handled = fs_handled(abi);
    for (size_t k = 0; k < n_ro; k++)
      if (ll_allow(ruleset, ro[k], fs_ro(), handled) != 0) fail(ro[k]);
    for (size_t k = 0; k < n_rw; k++)
      if (ll_allow(ruleset, rw[k], fs_rw(abi), handled) != 0) fail(rw[k]);
    if (syscall(__NR_landlock_restrict_self, ruleset, 0) != 0) fail("cannot apply the file rule set");
    close(ruleset);
  }

  if (apply_seccomp() != 0) fail("cannot apply the system-call filter");

  execvp(argv[i], &argv[i]);
  fprintf(stderr, NAME ": cannot start %s: %s\n", argv[i], strerror(errno));
  return errno == ENOENT ? 127 : EXIT_SETUP;
}
