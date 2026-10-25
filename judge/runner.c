// Trusted production runner. Runs as root inside a Modal sandbox; drops the child to 65534.
// usage: runner <compile|run> <wall_ms> <cpu_s> <as_mb|0> <stack_mb> <fsize_kb> <nofile> <out_cap> <memguard_mb> <disk_mb> <disk_base_mb|-1> -- argv...
// v2: stack separate from AS; /dev/shm locked; MemAvailable guard -> "mle"; statvfs disk quota -> "disk"; SysV IPC cleanup.
//   compile: source read from stdin into /work/sub/main.cpp; child stdout+stderr captured (diagnostics).
//   run:     stdin relayed to child; child stdout captured; child stderr discarded.
// stdout: captured bytes (<= out_cap+1). stderr: one JSON trailer line.
#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <mntent.h>
#include <poll.h>
#include <signal.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/shm.h>
#include <sys/msg.h>
#include <sys/sem.h>
#include <sys/statvfs.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define NOBODY 65534
static long long now_ms(void) {
  struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t);
  return (long long)t.tv_sec * 1000 + t.tv_nsec / 1000000;
}
static void setlim(int r, rlim_t v) { struct rlimit l = {v, v}; if (setrlimit(r, &l)) _exit(126); }
// Modal gVisor supports SysV objects but does not expose /proc/sysvipc.
// Deny all SysV operations instead of mistaking missing enumeration for an empty namespace.
// This filter is inherited by compiler/contestant descendants and cannot be removed.
static int deny_sysv_ipc(void) {
#if !defined(__x86_64__)
#error The reviewed judge image and syscall filter require x86_64
#endif
#define DENY_SYSCALL(n) BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (n), 0, 1), BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM)
  struct sock_filter filter[] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
    // i386 ipc multiplexing fails the architecture check; x32 numbers fail here.
    BPF_JUMP(BPF_JMP | BPF_JGE | BPF_K, 0x40000000, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
    DENY_SYSCALL(SYS_shmget), DENY_SYSCALL(SYS_shmat),
    DENY_SYSCALL(SYS_shmdt), DENY_SYSCALL(SYS_shmctl),
    DENY_SYSCALL(SYS_msgget), DENY_SYSCALL(SYS_msgsnd),
    DENY_SYSCALL(SYS_msgrcv), DENY_SYSCALL(SYS_msgctl),
    DENY_SYSCALL(SYS_semget), DENY_SYSCALL(SYS_semop),
    DENY_SYSCALL(SYS_semtimedop), DENY_SYSCALL(SYS_semctl),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW)
  };
#undef DENY_SYSCALL
  struct sock_fprog program = { .len = sizeof filter / sizeof filter[0], .filter = filter };
  return prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program);
}
static void close_child_fds(void) {
  DIR *d = opendir("/proc/self/fd"); if (!d) _exit(126);
  int own = dirfd(d); struct dirent *e;
  while ((e = readdir(d))) {
    char *end; long fd = strtol(e->d_name, &end, 10);
    if (*end == 0 && fd >= 3 && fd != own) close((int)fd);
  }
  closedir(d);
}
static int count_nobody(void) {
  DIR *d = opendir("/proc"); if (!d) return -1;
  struct dirent *e; int n = 0;
  while ((e = readdir(d))) {
    if (e->d_name[0] < '0' || e->d_name[0] > '9') continue;
    char p[4096]; snprintf(p, sizeof p, "/proc/%s/status", e->d_name);
    FILE *f = fopen(p,"r"); if (!f) { if(errno != ENOENT && errno != ESRCH)n++; continue; }
    // /proc/<pid> directory ownership becomes root for PR_SET_DUMPABLE=0.
    // Uid in status remains authoritative even for deliberately non-dumpable daemons.
    char line[512];
    while(fgets(line,sizeof line,f)) {
      unsigned r,effective,saved,fs;
      if(sscanf(line,"Uid: %u %u %u %u",&r,&effective,&saved,&fs)==4) {
        if(r==NOBODY||effective==NOBODY||saved==NOBODY||fs==NOBODY)n++;
        break;
      }
    }
    fclose(f);
  }
  closedir(d); return n;
}
// kill(-1) from a process running as 65534 signals every 65534 process, including setsid'd daemons.
static void sweep_once(void) {
  pid_t h = fork();
  if (h == 0) {
    if (setresgid(NOBODY, NOBODY, NOBODY) || setresuid(NOBODY, NOBODY, NOBODY)) _exit(1);
    kill(-1, SIGKILL); _exit(0);
  }
  if (h > 0) waitpid(h, NULL, 0);
}
static int sweep(int *left) {
  int i;
  for (i = 0; i < 10; i++) {
    sweep_once();
    while (waitpid(-1, NULL, WNOHANG) > 0) {}
    usleep(2000);
    if ((*left = count_nobody()) == 0) return i + 1;
  }
  return i;
}
static long mem_avail_mb(int fd) {
  char b[512]; ssize_t n = pread(fd, b, sizeof b - 1, 0); if (n <= 0) return -1; b[n] = 0;
  char *p = strstr(b, "MemAvailable:"); return p ? atol(p + 13) / 1024 : -1;
}
// Deduplicate writable filesystems; the quota baseline survives all runner execs.
static char disk_paths[128][4096];
static int disk_count;
static int prepare_mounts(void) {
  FILE *f = setmntent("/proc/self/mounts", "r"); if (!f) return -1;
  struct mntent *m;
  while ((m = getmntent(f))) {
    if (!strcmp(m->mnt_type, "tmpfs") || !strcmp(m->mnt_type, "shm") || !strcmp(m->mnt_type, "mqueue")) {
      if (chmod(m->mnt_dir, 0700)) {
        struct statvfs v;
        // Read-only memory mounts are already locked; never tolerate a writable failure.
        if (errno != EROFS || statvfs(m->mnt_dir,&v) || !(v.f_flag & ST_RDONLY)) { endmntent(f); return -1; }
      }
    }
  }
  endmntent(f);
  // Check mount writability using the contestant identity, rather than root's access().
  f = setmntent("/proc/self/mounts", "r"); if (!f) return -1;
  dev_t devices[128]; disk_count = 0;
  while ((m = getmntent(f))) {
    pid_t c = fork(); if (c < 0) { endmntent(f); return -1; }
    if (!c) {
      if (setgroups(0, NULL) || setresgid(NOBODY,NOBODY,NOBODY) || setresuid(NOBODY,NOBODY,NOBODY)) _exit(2);
      _exit(access(m->mnt_dir, W_OK | X_OK) == 0 ? 0 : 1);
    }
    int status; if (waitpid(c, &status, 0) < 0 || !WIFEXITED(status) || WEXITSTATUS(status) == 2) { endmntent(f); return -1; }
    struct stat st;
    // Root filesystem must be measured even when its root directory is not writable.
    if (strcmp(m->mnt_dir, "/") && WEXITSTATUS(status)) continue;
    if (stat(m->mnt_dir, &st)) { endmntent(f); return -1; }
    int seen = 0; for (int i=0; i<disk_count; i++) if (devices[i] == st.st_dev) seen = 1;
    if (!seen) {
      if (disk_count == 128 || strlen(m->mnt_dir) >= 4096) { endmntent(f); return -1; }
      devices[disk_count] = st.st_dev; strcpy(disk_paths[disk_count++], m->mnt_dir);
    }
  }
  endmntent(f); return disk_count ? 0 : -1;
}
static long disk_used_mb(void) {
  unsigned long long bytes = 0;
  for (int i=0; i<disk_count; i++) {
    struct statvfs v; if (statvfs(disk_paths[i], &v)) return -1;
    bytes += (unsigned long long)(v.f_blocks - v.f_bfree) * v.f_frsize;
  }
  return (long)(bytes >> 20);
}
// Root traverses through directory fds; never follows a contestant symlink.
// Each level holds two fds and a stack frame, so a contestant tree deeper than this is reported as leftover.
#define WIPE_DEPTH 128
static int wipe(int dirfd, int depth) {
  if (depth >= WIPE_DEPTH) return -1;
  DIR *d = fdopendir(dup(dirfd)); if (!d) return -1;
  struct dirent *e; int result = 0;
  while ((e = readdir(d))) {
    if (!strcmp(e->d_name,".") || !strcmp(e->d_name,"..")) continue;
    struct stat st;
    if (fstatat(dirfd,e->d_name,&st,AT_SYMLINK_NOFOLLOW)) { result=-1; break; }
    if (S_ISDIR(st.st_mode)) {
      int sub = openat(dirfd,e->d_name,O_RDONLY|O_DIRECTORY|O_NOFOLLOW);
      if (sub < 0 || wipe(sub, depth + 1)) result=-1;
      if (sub >= 0) close(sub);
      if (st.st_uid == NOBODY && unlinkat(dirfd,e->d_name,AT_REMOVEDIR)) result=-1;
    } else if (st.st_uid == NOBODY && unlinkat(dirfd,e->d_name,0)) result=-1;
    if (result) break;
  }
  closedir(d); return result;
}
static int wipe_tests(void) {
  const char *paths[] = {"/tmp", "/work/sub"};
  for (int i=0; i<2; i++) {
    int fd = open(paths[i],O_RDONLY|O_DIRECTORY|O_NOFOLLOW);
    if (fd < 0) return -1;
    int result = wipe(fd, 0); close(fd); if (result) return -1;
  }
  return 0;
}
static int promote_binary(void) {
  int fd = open("/work/sub/a.out",O_RDONLY|O_NOFOLLOW);
  struct stat st;
  if (fd < 0 || fstat(fd,&st) || !S_ISREG(st.st_mode) || st.st_uid != NOBODY || st.st_nlink != 1) { if(fd>=0)close(fd); return -1; }
  // No surviving contestant processes exist when ownership changes.
  int result = fchown(fd,0,0) || fchmod(fd,0755) || rename("/work/sub/a.out","/work/bin/a.out");
  close(fd); return result ? -1 : 0;
}
// Files and processes are not the only way to retain a previous test's input.
static int ipc_cleanup(void) {
  const char *paths[]={"/proc/sysvipc/shm","/proc/sysvipc/msg","/proc/sysvipc/sem"};
  int result=0;
  for(int kind=0;kind<3;kind++) {
    FILE *f=fopen(paths[kind],"r");
    if(!f) { if(errno!=ENOENT)result=-1; continue; }
    char line[1024]; if(!fgets(line,sizeof line,f)) { fclose(f); return -1; }
    while(fgets(line,sizeof line,f)) {
      char *save=NULL,*token=strtok_r(line," \t\n",&save);long id=-1,uid=-1,cuid=-1;int index=0;
      while(token) {
        if(index==1)id=strtol(token,NULL,10);
        if(index==(kind==2?4:7))uid=strtol(token,NULL,10);
        if(index==(kind==2?6:9))cuid=strtol(token,NULL,10);
        token=strtok_r(NULL," \t\n",&save);index++;
      }
      if((uid==NOBODY || cuid==NOBODY) && id>=0) {
        int r=kind==0?shmctl((int)id,IPC_RMID,NULL):kind==1?msgctl((int)id,IPC_RMID,NULL):semctl((int)id,0,IPC_RMID);
        if(r<0 && errno!=EINVAL && errno!=EIDRM)result=-1;
      }
    }
    if(ferror(f))result=-1;
    fclose(f);
  }
  return result;
}
int main(int argc, char **argv) {
  if (argc < 14 || strcmp(argv[12], "--")) { fprintf(stderr, "{\"status\":\"usage\"}\n"); return 2; }
  int compile = !strcmp(argv[1], "compile");
  long wall = atol(argv[2]), cpu = atol(argv[3]), as_mb = atol(argv[4]), stack_mb = atol(argv[5]), fsize_kb = atol(argv[6]);
  long nofile = atol(argv[7]), cap = atol(argv[8]), guard_mb = atol(argv[9]), disk_mb = atol(argv[10]);
  char **cargv = argv + 13;
  // Deny /proc/<runner>/fd/2 even when the underlying pipe is writable.
  if (prctl(PR_SET_DUMPABLE, 0) || prctl(PR_SET_CHILD_SUBREAPER, 1)) return 3;
  clearenv();
  if (prepare_mounts() || chmod("/var/tmp",0700)) return 3;
  int prior_left = -1; sweep(&prior_left);
  if (prior_left != 0 || ipc_cleanup() || (!compile && wipe_tests())) return 3;
  int memfd = open("/proc/meminfo", O_RDONLY);
  long disk0 = atol(argv[11]), used0 = disk_used_mb(), min_avail = 1L << 30, disk_peak = 0;
  if (compile) disk0 = used0;
  if (memfd < 0 || disk0 < 0 || used0 < 0 || mem_avail_mb(memfd) < 0) return 3;
  signal(SIGPIPE, SIG_IGN);
  if (compile) {
    int fd = open("/work/sub/main.cpp", O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, 0600);
    if (fd < 0) { fprintf(stderr, "{\"status\":\"ie\",\"why\":\"open\"}\n"); return 3; }
    char b[65536]; long tot = 0;
    for (;;) {
      ssize_t r=read(0,b,sizeof b);
      if(r==0)break;
      if(r<0) { if(errno==EINTR)continue; close(fd); return 3; }
      tot+=r;if(tot>65536) { close(fd); return 3; }
      ssize_t offset=0;
      while(offset<r) {
        ssize_t written=write(fd,b+offset,(size_t)(r-offset));
        if(written<0 && errno==EINTR)continue;
        if(written<=0) { close(fd); return 3; }
        offset+=written;
      }
    }
    if(fchown(fd,NOBODY,NOBODY)) { close(fd); return 3; }
    if(close(fd))return 3;
  }
  int in[2], out[2];
  if (pipe(in) || pipe(out)) return 3;
  long long t0 = now_ms();
  pid_t c = fork();
  if (c < 0) return 3;
  if (c == 0) {
    setpgid(0, 0);
    int devnull = open("/dev/null", O_RDWR);
    dup2(compile ? devnull : in[0], 0);
    dup2(out[1], 1);
    dup2(compile ? out[1] : devnull, 2);
    close_child_fds();
    setlim(RLIMIT_CPU, cpu); setlim(RLIMIT_FSIZE, (rlim_t)fsize_kb * 1024); setlim(RLIMIT_NOFILE, nofile);
    setlim(RLIMIT_CORE, 0); setlim(RLIMIT_NPROC, 64);
    if (as_mb > 0) setlim(RLIMIT_AS, (rlim_t)as_mb << 20);
    setlim(RLIMIT_STACK, (rlim_t)stack_mb << 20);
    if (setgroups(0, NULL) || setresgid(NOBODY, NOBODY, NOBODY) || setresuid(NOBODY, NOBODY, NOBODY)) _exit(126);
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) _exit(126);
    if (deny_sysv_ipc()) _exit(126);
    if (chdir("/work/sub")) _exit(126);
    char *envp[] = {"PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/work/sub", "LANG=C", NULL};
    execve(cargv[0], cargv, envp);
    _exit(127);
  }
  setpgid(c, c);
  close(in[0]); close(out[1]);
  if (compile) close(in[1]);
  fcntl(out[0], F_SETFL, O_NONBLOCK);
  if (!compile) fcntl(in[1], F_SETFL, O_NONBLOCK);
  char *buf = malloc(cap + 2); long got = 0;
  char ib[65536]; ssize_t ilen = 0, ioff = 0; int in_eof = compile, child_in_open = !compile;
  int status = 0, reaped = 0, tle = 0, ole = 0, mle = 0, disk = 0;
  struct rusage ru; memset(&ru, 0, sizeof ru);
  while (!reaped) {
    long long rem = wall - (now_ms() - t0);
    if (rem <= 0) { tle = 1; break; }
    struct pollfd p[3]; int n = 0, ip = -1, op = -1, sp = -1;
    p[n].fd = out[0]; p[n].events = POLLIN; op = n++;
    if (child_in_open && ilen > ioff) { p[n].fd = in[1]; p[n].events = POLLOUT; ip = n++; }
    else if (!in_eof) { p[n].fd = 0; p[n].events = POLLIN; sp = n++; }
    poll(p, n, rem < 5 ? (int)rem : 5);
    if (op >= 0 && (p[op].revents & (POLLIN | POLLHUP))) {
      for (;;) {
        ssize_t r = read(out[0], buf + got, cap + 1 - got);
        if (r > 0) { got += r; if (got > cap) { ole = 1; break; } } else break;
      }
      if (ole) break;
    }
    if (sp >= 0 && (p[sp].revents & (POLLIN | POLLHUP))) {
      ilen = read(0, ib, sizeof ib); ioff = 0;
      if (ilen <= 0) { ilen = 0; in_eof = 1; close(in[1]); child_in_open = 0; }
    }
    if (ip >= 0 && (p[ip].revents & (POLLOUT | POLLERR | POLLHUP))) {
      ssize_t w = write(in[1], ib + ioff, ilen - ioff);
      if (w > 0) ioff += w;
      else if (w < 0 && errno != EAGAIN) { close(in[1]); child_in_open = 0; ilen = ioff = 0; }
    }
    if (!child_in_open && !in_eof) { // child closed stdin: drain ours so the exec stream completes
      struct pollfd drain = {0, POLLIN, 0};
      if (poll(&drain, 1, 0) > 0) { ssize_t r = read(0, ib, sizeof ib); if (r <= 0) in_eof = 1; }
    }
    long av = mem_avail_mb(memfd); if (av >= 0 && av < min_avail) min_avail = av;
    if (av >= 0 && av < guard_mb) { mle = 1; break; }
    long used = disk_used_mb(); if (used < 0 || av < 0) { disk = 1; break; }
    long du = used - disk0; if (du > disk_peak) disk_peak = du;
    if (du > disk_mb) { disk = 1; break; }
    if (wait4(c, &status, WNOHANG, &ru) == c) reaped = 1;
  }
  if (!reaped) { kill(-c, SIGKILL); wait4(c, &status, 0, &ru); }
  long long wall_ms = now_ms() - t0;
  // drain whatever the child already wrote, without blocking on a daemon holding the pipe
  if (!ole) for (;;) { ssize_t r = read(out[0], buf + got, cap + 1 - got); if (r > 0) { got += r; if (got > cap) { ole = 1; break; } } else break; }
  kill(-c, SIGKILL);
  int left = -1, sweeps = sweep(&left);
  int ipc_failed = ipc_cleanup();
  // Attribute contestant files that cannot be removed to this run; the next run must start clean.
  int wipe_failed = !compile && left == 0 && wipe_tests();
  // A program may exit without consuming stdin. Drain only the bounded current input,
  // within the remaining controller allowance, so its writer can finish normally.
  if (!compile && !in_eof) {
    long long deadline = t0 + wall + 1000;
    while (!in_eof && now_ms() < deadline) {
      struct pollfd drain = {0,POLLIN,0};
      if (poll(&drain,1,5) > 0) { ssize_t r=read(0,ib,sizeof ib); if (r<=0) in_eof=1; }
    }
  }
  int promotion_failed = compile && reaped && WIFEXITED(status) && WEXITSTATUS(status) == 0 && left == 0 && !tle && !ole && !mle && !disk && promote_binary();
  fwrite(buf, 1, got > cap ? cap + 1 : got, stdout); fflush(stdout);
  const char *st = (left != 0 || ipc_failed || wipe_failed) ? "leftover" : promotion_failed ? "re" : mle ? "mle" : disk ? "disk" : ole ? "ole" : tle ? "tle" : WIFSIGNALED(status) ? "signal" : WEXITSTATUS(status) ? "re" : "ok";
  long cpums = ru.ru_utime.tv_sec * 1000 + ru.ru_utime.tv_usec / 1000 + ru.ru_stime.tv_sec * 1000 + ru.ru_stime.tv_usec / 1000;
  fprintf(stderr, "{\"status\":\"%s\",\"exitCode\":%d,\"signal\":%d,\"wallMs\":%lld,\"cpuMs\":%ld,\"maxrssKb\":%ld,\"outBytes\":%ld,\"leftover\":%d,\"sweeps\":%d,\"minAvailMb\":%ld,\"diskPeakMb\":%ld,\"diskBaseMb\":%ld,\"v\":3}\n",
          st, WIFEXITED(status) ? WEXITSTATUS(status) : -1, WIFSIGNALED(status) ? WTERMSIG(status) : 0, wall_ms, cpums,
          ru.ru_maxrss, got, left, sweeps, min_avail, disk_peak, disk0);
  return 0;
}
