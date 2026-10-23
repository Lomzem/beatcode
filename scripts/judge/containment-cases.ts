// Public adversarial fixtures. Compile and execute ONLY inside Modal through verify-containment.ts.
export const containmentCases: {
	name: string;
	expected: string;
	source: string;
	samples: { input: string; output: string }[];
	profile?: 'std' | 'strict';
}[] = [
	{
		name: 'cross-test-files',
		expected: 'AC',
		source: `
#include <cstdio>
#include <unistd.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <sys/syscall.h>
#include <csignal>
#include <sys/msg.h>
#include <sys/sem.h>
#include <sys/shm.h>
#include <cerrno>
int main(){
if(msgget(0x42b1,0666)>=0||semget(0x42b2,1,0666)>=0||shmget(0x42b3,1,0666)>=0){puts("ipc-dirty");return 0;}
// Production intentionally denies SysV creation: gVisor lacks proc enumeration.
// Check every class independently so a missing object or unsupported API cannot fake denial.
errno=0;int q=msgget(IPC_PRIVATE,IPC_CREAT|0666),qe=errno;
errno=0;int se=semget(IPC_PRIVATE,1,IPC_CREAT|0666),see=errno;
errno=0;int sh=shmget(IPC_PRIVATE,4096,IPC_CREAT|0666),she=errno;
if(q>=0||se>=0||sh>=0||qe!=EPERM||see!=EPERM||she!=EPERM){puts("ipc-creation-allowed");return 0;}
// Bad arguments would produce EINVAL/EFAULT without the policy; require EPERM for every operation.
long ops[]={SYS_shmat,SYS_shmdt,SYS_shmctl,SYS_msgsnd,SYS_msgrcv,SYS_msgctl,SYS_semop,SYS_semtimedop,SYS_semctl};
for(long op:ops){errno=0;if(syscall(op,-1L,0L,0L,0L,0L,0L)!=-1||errno!=EPERM){puts("ipc-operation-allowed");return 0;}}
errno=0;if(syscall(SYS_shmget|0x40000000,0,4096,IPC_CREAT|0666)!=-1||(errno!=EPERM&&errno!=ENOSYS)){puts("ipc-x32-allowed");return 0;}
int input=getchar();(void)input;
pid_t child=fork();if(child<0){puts("fork-failed");return 0;}if(child==0){errno=0;int id=shmget(IPC_PRIVATE,4096,IPC_CREAT|0666);_exit(id<0&&errno==EPERM?0:1);}int status=0;if(waitpid(child,&status,0)!=child||!WIFEXITED(status)||WEXITSTATUS(status)!=0){puts("ipc-child-allowed");return 0;}
pid_t compat=fork();if(compat<0){puts("fork-failed");return 0;}if(compat==0){long result;asm volatile("int $0x80":"=a"(result):"a"(117),"b"(2),"c"(0),"d"(1),"S"(IPC_CREAT|0666):"memory");_exit(1);}if(waitpid(compat,&status,0)!=compat||!WIFSIGNALED(status)){puts("ipc-compat-allowed");return 0;}
struct stat st;if(stat("/work/bin/a.out",&st)||st.st_uid!=0||access("/work/bin/a.out",W_OK)==0||access("main.cpp",F_OK)==0){puts("binary-unprotected");return 0;}
FILE*other=fopen("/var/tmp/beatcode-state","w");if(other){puts("other-writable");fclose(other);return 0;}
if(access("/tmp/beatcode-state",F_OK)==0 || access("state",F_OK)==0){puts("dirty");return 0;}
FILE*f=fopen("/tmp/beatcode-state","w");if(f){fputs("x",f);fclose(f);}f=fopen("state","w");if(f){fputs("x",f);fclose(f);}puts("clean");}`,
		samples: [
			{ input: '1', output: 'clean' },
			{ input: '2', output: 'clean' },
			{ input: '3', output: 'clean' }
		]
	},
	{
		name: 'runner-fd-forgery',
		expected: 'AC',
		source: `
#include <dirent.h>
#include <fcntl.h>
#include <cstdio>
#include <unistd.h>
int main(){DIR*d=opendir("/proc");dirent*e;int opened=0;while((e=readdir(d))){int p=atoi(e->d_name);if(p<=0||p==getpid())continue;
char path[128];sprintf(path,"/proc/%d/fd/2",p);int f=open(path,O_WRONLY);if(f>=0){const char forged[]={123,34,115,116,97,116,117,115,34,58,34,105,101,34,125,10};write(f,forged,sizeof forged);close(f);opened++;}}
puts(opened?"forged":"denied");}`.replace(
			'#include <cstdio>',
			'#include <cstdio>\n#include <cstdlib>'
		),
		samples: [{ input: '', output: 'denied' }]
	},
	{
		name: 'memory-backed-mounts',
		expected: 'AC',
		source: `
#include <cstdio>
#include <cstring>
#include <mntent.h>
#include <unistd.h>
int main(){FILE*f=setmntent("/proc/self/mounts","r");mntent*m;int bad=0;
while((m=getmntent(f)))if(!strcmp(m->mnt_type,"tmpfs")||!strcmp(m->mnt_type,"shm")||!strcmp(m->mnt_type,"mqueue"))if(access(m->mnt_dir,W_OK|X_OK)==0)bad++;
puts(bad?"writable":"locked");}`,
		samples: [{ input: '', output: 'locked' }]
	},
	{
		name: 'non-dumpable-daemon-sweep',
		expected: 'AC',
		source: `
#include <unistd.h>
#include <cstdio>
#include <sys/prctl.h>
int main(){if(fork()==0){prctl(PR_SET_DUMPABLE,0);setsid();if(fork()==0){for(;;)usleep(1000);}_exit(0);}puts("done");}`,
		samples: [
			{ input: '1', output: 'done' },
			{ input: '2', output: 'done' },
			{ input: '3', output: 'done' }
		]
	},
	{
		name: 'output-flood',
		expected: 'OLE',
		source: `
#include <unistd.h>
int main(){char b[4096]={};for(;;)write(1,b,sizeof b);}`,
		samples: [{ input: '', output: '' }]
	},
	{
		name: 'many-file-disk-growth',
		expected: 'RE',
		source: `
#include <cstdio>
int main(){char b[1024*1024]={};for(int i=0;i<1000;i++){char p[128];sprintf(p,"/tmp/disk-%d",i);FILE*f=fopen(p,"w");if(f){fwrite(b,1,sizeof b,f);fclose(f);}}puts("escaped");}`,
		samples: [{ input: '', output: 'bounded' }]
	},
	{
		name: 'per-attempt-disk-baseline',
		expected: 'RE',
		source: `
#include <cstdio>
int main(){char b[1024*1024]={};for(int i=0;i<40;i++){char p[128];sprintf(p,"/tmp/growth-%d",i);FILE*f=fopen(p,"w");if(f){fwrite(b,1,sizeof b,f);fclose(f);}}puts("escaped");}`,
		samples: [{ input: '', output: 'bounded' }]
	},
	{
		name: 'memory-burst',
		expected: 'MLE|sandbox_lost',
		source: `
#include <cstdlib>
#include <cstring>
#include <unistd.h>
int main(){for(int i=0;i<8;i++)if(fork()==0){for(;;){volatile unsigned char*p=(volatile unsigned char*)malloc(16*1024*1024);if(p)for(int j=0;j<16*1024*1024;j+=4096)p[j]=1;}_exit(0);}for(;;)pause();}`,
		samples: [{ input: '', output: '' }]
	}
];

const vla = `#include <cstdio>
int main(){int n;if(scanf("%d",&n)!=1)return 1;int a[n];a[0]=7;printf("%d\\n",a[0]);}`;
containmentCases.push(
	{ name: 'std-vla', expected: 'AC', source: vla, samples: [{ input: '3', output: '7' }] },
	{
		name: 'strict-vla',
		expected: 'CE',
		source: vla,
		profile: 'strict',
		samples: [{ input: '3', output: '7' }]
	},
	{
		name: 'typical-bits-solution',
		expected: 'AC',
		profile: 'strict',
		source: `#include <bits/stdc++.h>
using namespace std;int main(){long long a,b;cin>>a>>b;cout<<a+b<<"\\n";}`,
		samples: [{ input: '19 23', output: '42' }]
	},
	{
		name: 'scoped-network',
		expected: 'AC',
		source: `#include <cstdio>
#include <unistd.h>
#include <sys/socket.h>
#include <arpa/inet.h>
#include <netdb.h>
int main(){addrinfo*r=nullptr;int dns=getaddrinfo("example.com",nullptr,nullptr,&r);if(r)freeaddrinfo(r);
int fd=socket(AF_INET,SOCK_STREAM|SOCK_NONBLOCK,0);sockaddr_in a{};a.sin_family=AF_INET;a.sin_port=htons(443);inet_pton(AF_INET,"1.1.1.1",&a.sin_addr);int tcp=connect(fd,(sockaddr*)&a,sizeof a);close(fd);
fd=socket(AF_INET,SOCK_DGRAM,0);a.sin_port=htons(53);int udp=sendto(fd,"x",1,0,(sockaddr*)&a,sizeof a);close(fd);puts(dns!=0&&tcp<0&&udp<0?"blocked":"reachable");}`,
		samples: [{ input: '', output: 'blocked' }]
	},
	{
		name: 'fork-bomb',
		expected: 'TLE',
		source: `#include <unistd.h>
int main(){for(;;)if(fork()<0)usleep(1000);}`,
		samples: [{ input: '', output: '' }]
	}
);
