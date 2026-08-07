package registry

// The withdrawal set: the one thing the gateway remembers on purpose.
//
// Everything else the registry holds is a working copy of a record the control
// plane owns, and losing it is safe because losing it means the gateway carries
// nothing. A revocation is the opposite: losing it means the gateway carries
// something it was told to stop carrying. So the set of withdrawals is written
// through to a journal on disk, and a gateway that starts reads it back before
// it serves a request.
//
// Two kinds of subject, and the difference is what each one covers:
//
//   - A capability subject withdraws one credential by identity. It is the
//     narrow case: one browser session's access ends while the route stays up
//     for the others named on it.
//   - A route subject withdraws every capability that was outstanding for that
//     route at the instant it was revoked. The gateway never sees a capability
//     until it is presented, so it cannot enumerate them; what it can record is
//     the instant, and a capability carries a signed IssuedAt. "Issued at or
//     before the revocation" is therefore exactly "outstanding when the route
//     was revoked", computed rather than listed.
//
// The route subject is an instant and not a permanent ban on the identifier,
// because docs/DOMAIN_MODEL.md section 10 requires a route inside its lifetime
// to resume under the same identifier when its connector reconnects. Burning
// the identifier would forbid that; recording the instant does not, and still
// leaves a re-registration unable to resurrect a capability, because a
// capability minted before the revocation is refused however many times the
// route identifier is registered afterwards.

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// RevocationKind names what a withdrawal is about.
type RevocationKind string

const (
	// RevokeCapabilitySubject withdraws one capability by identity.
	RevokeCapabilitySubject RevocationKind = "capability"
	// RevokeRouteSubject withdraws every capability a route had outstanding.
	RevokeRouteSubject RevocationKind = "route"
)

// Revocation is one withdrawal the gateway must keep honouring.
type Revocation struct {
	Kind    RevocationKind `json:"kind"`
	Subject string         `json:"subject"`
	// RevokedAt is the instant authority ended. For a route subject it is also
	// the comparison point: a capability issued at or before it is refused.
	RevokedAt time.Time `json:"revoked_at"`
	// NotAfter is the instant after which the record may be forgotten, because
	// nothing it could refuse can still be presented. For a route it is the
	// route's own expiry, which bounds every capability minted for it
	// (docs/ARCHITECTURE.md section 7.3); for a capability it is an upper bound
	// on that capability's lifetime.
	NotAfter time.Time `json:"not_after"`
}

// Key is the identity of a withdrawal. Recording the same subject twice
// replaces rather than accumulates.
func (r Revocation) Key() string { return string(r.Kind) + ":" + r.Subject }

func capabilityKey(capabilityID string) string {
	return string(RevokeCapabilitySubject) + ":" + capabilityID
}

func routeKey(routeID string) string {
	return string(RevokeRouteSubject) + ":" + routeID
}

// Journal is where the withdrawal set survives a restart.
//
// It is an interface so that a test can drive a failing one: a revocation the
// gateway could not write down is a revocation it must not claim to have made,
// and that path has to be exercised.
type Journal interface {
	// Load returns every withdrawal recorded so far.
	Load() ([]Revocation, error)
	// Append records one withdrawal durably. It must not return until the entry
	// would survive the loss of the process.
	Append(Revocation) error
	// Compact rewrites the journal as exactly the entries given.
	Compact([]Revocation) error
}

// ErrJournalUnwritable reports a withdrawal that could not be made durable.
var ErrJournalUnwritable = errors.New("registry: the revocation could not be recorded")

// FileJournal is the shipped journal: one JSON object per line, appended and
// flushed to disk before the withdrawal is answered for.
//
// Newline-delimited JSON rather than a database, because the gateway holds no
// database connection and must not acquire one (docs/ARCHITECTURE.md section
// 4.6): giving the most exposed component a connection into the control plane's
// persistence would move a trust boundary to make a file easier to write. A
// partial line left by a torn write is dropped on load rather than failing the
// start, so a gateway that lost power mid-append still comes up honouring every
// withdrawal that was fully written.
type FileJournal struct {
	path string

	mu sync.Mutex
}

// NewFileJournal opens, and creates if needed, the journal at path.
func NewFileJournal(path string) (*FileJournal, error) {
	if strings.TrimSpace(path) == "" {
		return nil, errors.New("registry: the revocation journal needs a path")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return nil, err
	}
	if err := file.Close(); err != nil {
		return nil, err
	}
	return &FileJournal{path: path}, nil
}

// Path reports where the journal is kept.
func (j *FileJournal) Path() string { return j.path }

// Load reads every complete entry. An entry that does not decode is skipped:
// the alternative is a gateway that will not start because of one bad line,
// which trades a bounded loss for a total outage.
func (j *FileJournal) Load() ([]Revocation, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	contents, err := os.ReadFile(j.path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	entries := make([]Revocation, 0, 16)
	for _, line := range strings.Split(string(contents), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var entry Revocation
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			continue
		}
		if entry.Subject == "" || entry.Kind == "" {
			continue
		}
		entries = append(entries, entry)
	}
	return entries, nil
}

// Append writes one entry and flushes it. The flush is the whole point: an
// entry sitting in the page cache is not a durable revocation.
func (j *FileJournal) Append(entry Revocation) error {
	line, err := json.Marshal(entry)
	if err != nil {
		return err
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	file, err := os.OpenFile(j.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	if _, err := file.Write(append(line, '\n')); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return err
	}
	return file.Close()
}

// Compact rewrites the journal so it holds exactly the entries given. It writes
// a temporary file and renames it, so a crash leaves either the old journal or
// the new one and never a half-written one.
func (j *FileJournal) Compact(entries []Revocation) error {
	sorted := append([]Revocation(nil), entries...)
	sort.Slice(sorted, func(a, b int) bool { return sorted[a].Key() < sorted[b].Key() })

	var buffer strings.Builder
	for _, entry := range sorted {
		line, err := json.Marshal(entry)
		if err != nil {
			return err
		}
		buffer.Write(line)
		buffer.WriteByte('\n')
	}

	j.mu.Lock()
	defer j.mu.Unlock()
	temporary := j.path + ".compacting"
	file, err := os.OpenFile(temporary, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err := file.WriteString(buffer.String()); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporary, j.path); err != nil {
		return err
	}
	directory, err := os.Open(filepath.Dir(j.path))
	if err != nil {
		return err
	}
	// A rename is only durable once the directory entry is flushed too.
	_ = directory.Sync()
	return directory.Close()
}
