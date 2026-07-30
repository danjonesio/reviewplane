//go:build !unix

package identity

import "os"

// checkOwnership has no portable implementation outside unix. The mode check in
// CheckKeyPermissions still applies.
func checkOwnership(string, os.FileInfo) error { return nil }
