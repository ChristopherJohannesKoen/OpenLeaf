/*
 * libopenleaf-guard.so: loaded into the OpenLeaf service itself (LD_PRELOAD), it makes the
 * service's memory and environment unreadable to other processes of the same user.
 *
 * A process started by the same user may normally read another's environment and memory
 * through /proc/<pid>/environ and /proc/<pid>/mem. The service holds the database address
 * and the key for stored GitHub tokens there, and it starts LaTeX, which runs untrusted
 * documents, as the same user. Marking the service "not dumpable" hands those /proc files
 * to root and refuses ptrace from that user, at the cost of core dumps, which the service
 * does not want anyway.
 *
 * The mark does not survive starting another program, so it has to be set from inside the
 * service's own process; a preloaded library is the smallest way to do that. Programs the
 * service starts are not affected unless they are given LD_PRELOAD too.
 *
 * Build:  cc -O2 -Wall -Wextra -shared -fPIC -o libopenleaf-guard.so guard.c
 */
#include <sys/prctl.h>

__attribute__((constructor)) static void openleaf_guard(void) { prctl(PR_SET_DUMPABLE, 0, 0, 0, 0); }
