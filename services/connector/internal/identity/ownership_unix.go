//go:build unix

package identity

import (
	"fmt"
	"os"
	"syscall"
)

// checkOwnership refuses a private key owned by another account. Owner-only
// permissions mean nothing if the owner is not this process.
func checkOwnership(path string, info os.FileInfo) error {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return nil
	}
	uid := os.Getuid()
	if uid < 0 || int(stat.Uid) == uid {
		return nil
	}
	return &PermissionError{
		Path:   path,
		Detail: fmt.Sprintf("the private key is owned by uid %d but this process runs as uid %d", stat.Uid, uid),
	}
}
