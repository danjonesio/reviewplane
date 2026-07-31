package platformv1

import (
	"regexp"
	"strings"
)

// Repository-identity normalisation (docs/DOMAIN_MODEL.md section 6).
//
// This is the Go half of src/repository-identity.ts. The two must agree byte
// for byte, because they answer the same question about the same repository
// from opposite ends of the product: the connector reduces a checkout's remote
// to the canonical form before it reports a workspace observation
// (docs/CONNECTOR_PROTOCOL.md section 9), and the control plane reduces what an
// operator typed before it stores a project. A disagreement would not look like
// a normalisation bug — it would look like a project that has quietly forgotten
// its code, because the connector's observation would never match the project's
// stored identity.
//
// The committed corpus fixtures/platform/v1/repository-identity.json is what
// holds the two implementations together: both languages run it, so a rule
// changed in one alone fails the other.
//
// Normalisation is deliberately lossy in one direction only: it removes a
// scheme, a userinfo component, a default port, a .git suffix and trailing
// slashes, and it lowercases the host. It never rewrites a path's case, because
// on most forges the path is case-sensitive and two projects may differ by it.
//
// A userinfo component is dropped rather than preserved, and never stored:
// https://someone:token@example.com/repo.git is a credential in a URL, and
// docs/SECURITY.md section 18 does not stop applying because a caller pasted it
// into a form or committed it to a remote.

// RepositoryIdentityFailure is why a value could not be normalised. The
// vocabulary is stable, so a caller can branch on it rather than on a message.
type RepositoryIdentityFailure string

const (
	RepositoryIdentityEmpty             RepositoryIdentityFailure = "empty"
	RepositoryIdentityTooLong           RepositoryIdentityFailure = "too_long"
	RepositoryIdentityInvalidCharacters RepositoryIdentityFailure = "invalid_characters"
	RepositoryIdentityUnsupportedScheme RepositoryIdentityFailure = "unsupported_scheme"
	RepositoryIdentityMissingHost       RepositoryIdentityFailure = "missing_host"
	RepositoryIdentityMissingPath       RepositoryIdentityFailure = "missing_path"
)

// RepositoryIdentityError reports a clone URL that could not be reduced.
type RepositoryIdentityError struct {
	Reason RepositoryIdentityFailure
}

func (e *RepositoryIdentityError) Error() string {
	if e == nil {
		return "<nil>"
	}
	return "platformv1: repository identity " + string(e.Reason)
}

// Bounds from schemas/platform/v1.schema.json. They are counted in UTF-16 code
// units rather than in bytes, because the TypeScript implementation measures
// String.prototype.length and the two must refuse the same values for the same
// reason. A value long enough to matter is ASCII in practice; measuring the
// same way is what keeps a corpus case from reporting too_long in one language
// and invalid_characters in the other.
const (
	MaxCloneURLLength  = 512
	MaxCanonicalLength = 255
)

// canonicalRepositoryPattern is the canonical form the schema accepts, kept in
// step with $defs.repository_identity by the corpus.
var canonicalRepositoryPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]*(:[0-9]{1,5})?(/[A-Za-z0-9._~-]+)+$`)

// defaultPorts are the schemes a clone URL may carry, with the port that is
// implied rather than recorded. "file" is absent deliberately: a path on one
// machine is not a repository identity any other machine can resolve.
var defaultPorts = map[string]string{
	"https": "443",
	"http":  "80",
	"ssh":   "22",
	"git":   "9418",
}

// CanonicaliseCloneURL reduces one clone URL to the canonical form.
//
// It handles the three shapes in use: an ordinary URL, Git's scp-like
// user@host:path, and the bare host/path a human types.
func CanonicaliseCloneURL(raw string) (string, error) {
	trimmed := strings.TrimFunc(raw, isECMAScriptSpace)
	if trimmed == "" {
		return "", &RepositoryIdentityError{Reason: RepositoryIdentityEmpty}
	}
	if utf16Length(trimmed) > MaxCloneURLLength {
		return "", &RepositoryIdentityError{Reason: RepositoryIdentityTooLong}
	}
	// Control characters and whitespace never belong in a remote, and a value
	// carrying one is far more likely to be a paste accident than a repository.
	if strings.IndexFunc(trimmed, isForbiddenInCloneURL) >= 0 {
		return "", &RepositoryIdentityError{Reason: RepositoryIdentityInvalidCharacters}
	}

	var authority, path, scheme string
	if declared, rest, ok := splitScheme(trimmed); ok {
		if _, known := defaultPorts[declared]; !known {
			return "", &RepositoryIdentityError{Reason: RepositoryIdentityUnsupportedScheme}
		}
		scheme = declared
		if slash := strings.IndexByte(rest, '/'); slash >= 0 {
			authority, path = rest[:slash], rest[slash+1:]
		} else {
			authority, path = rest, ""
		}
	} else if isScpLike(trimmed) {
		// scp-like: git@host:example/repo.git, or host:example/repo.git. Git
		// only ever speaks that form over SSH, so the scheme is known even
		// though the URL does not name it.
		colon := strings.IndexByte(trimmed, ':')
		authority, path = trimmed[:colon], trimmed[colon+1:]
		scheme = "ssh"
	} else {
		slash := strings.IndexByte(trimmed, '/')
		if slash < 0 {
			return "", &RepositoryIdentityError{Reason: RepositoryIdentityMissingPath}
		}
		authority, path = trimmed[:slash], trimmed[slash+1:]
	}

	// The credential half of an authority is dropped, never stored.
	host := authority
	if at := strings.LastIndexByte(authority, '@'); at >= 0 {
		host = authority[at+1:]
	}
	if host == "" {
		return "", &RepositoryIdentityError{Reason: RepositoryIdentityMissingHost}
	}

	port := ""
	if name, declared, ok := splitPort(host); ok {
		host, port = name, declared
		// A port the scheme already implies is noise: https://host:443/x and
		// https://host/x are one repository, and storing both spellings would
		// make them two.
		if scheme != "" && defaultPorts[scheme] == port {
			port = ""
		}
	}
	host = strings.ToLower(host)

	segments := make([]string, 0, 4)
	for _, segment := range strings.Split(path, "/") {
		segment = strings.TrimFunc(segment, isECMAScriptSpace)
		if segment != "" {
			segments = append(segments, segment)
		}
	}
	if len(segments) == 0 {
		return "", &RepositoryIdentityError{Reason: RepositoryIdentityMissingPath}
	}
	segments[len(segments)-1] = trimGitSuffix(segments[len(segments)-1])
	if segments[len(segments)-1] == "" {
		return "", &RepositoryIdentityError{Reason: RepositoryIdentityMissingPath}
	}

	canonical := host
	if port != "" {
		canonical += ":" + port
	}
	canonical += "/" + strings.Join(segments, "/")
	if utf16Length(canonical) > MaxCanonicalLength {
		return "", &RepositoryIdentityError{Reason: RepositoryIdentityTooLong}
	}
	if !canonicalRepositoryPattern.MatchString(canonical) {
		return "", &RepositoryIdentityError{Reason: RepositoryIdentityInvalidCharacters}
	}
	return canonical, nil
}

// SanitiseCloneURL removes credential material from a clone URL without
// otherwise rewriting it.
//
// What counts as a credential depends on the transport, and getting that
// distinction wrong in either direction is a real fault:
//
//   - Over SSH, git@github.com:… and ssh://git@host/… name the account to log
//     in as. The secret is a key on disk and is never in the URL, so a bare
//     username is kept — dropping it would store a URL that does not clone. A
//     user:password pair still goes, because a password in an SSH URL is a
//     credential whatever the transport.
//   - Over every other scheme, the whole userinfo component goes, colon or no
//     colon. https://ghp_…@github.com/example/repo.git is how every forge
//     documents cloning with a personal access token, so a bare userinfo there
//     is overwhelmingly a secret rather than an account name; and git:// is the
//     unauthenticated daemon protocol, which has no credential mechanism at
//     all, so a userinfo there cannot be an account to log in as and is an
//     accidental paste.
//
// The test is therefore "is this SSH?" rather than a list of the schemes that
// carry secrets. Enumerating them is what left git:// behind once already, and
// it would leave behind whatever scheme is accepted next: an unrecognised
// scheme is treated as secret-bearing, which is the direction that is safe to
// be wrong in.
//
// The rule errs towards deletion: an operator who loses a username from a URL
// has a URL to correct, and one who does not lose a token has a token in a
// database, in every backup of it, and on the screen of anyone who opens the
// project (docs/SECURITY.md section 18).
func SanitiseCloneURL(raw string) string {
	trimmed := strings.TrimFunc(raw, isECMAScriptSpace)
	if scheme, rest, ok := splitScheme(trimmed); ok {
		userinfo, remainder := splitUserinfo(rest)
		// An unrecognised scheme is treated as secret-bearing, so only SSH
		// without a password keeps its account name.
		carriesSecret := scheme != "ssh" || strings.Contains(userinfo, ":")
		if carriesSecret {
			userinfo = ""
		}
		return scheme + "://" + userinfo + remainder
	}
	// scp-like user@host:path, which Git only ever speaks over SSH.
	if userinfo, remainder := splitUserinfo(trimmed); userinfo != "" {
		if strings.Contains(userinfo, ":") {
			userinfo = ""
		}
		return userinfo + remainder
	}
	return trimmed
}

// splitScheme reports the lowercased scheme and the text after "://".
//
// The scheme character class carries neither ":" nor "/", so the only candidate
// is the run of scheme characters at the start of the value; anything else is
// not a URL with a scheme, whatever else it may be.
func splitScheme(value string) (scheme, rest string, ok bool) {
	end := 0
	for end < len(value) && isSchemeByte(value[end], end) {
		end++
	}
	if end == 0 || !strings.HasPrefix(value[end:], "://") {
		return "", "", false
	}
	return strings.ToLower(value[:end]), value[end+3:], true
}

func isSchemeByte(b byte, index int) bool {
	isLetter := (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z')
	if index == 0 {
		return isLetter
	}
	return isLetter || (b >= '0' && b <= '9') || b == '+' || b == '.' || b == '-'
}

// splitUserinfo separates a leading "userinfo@" from the rest of an authority.
// The userinfo is the text before the first "@" and may not contain "/", so a
// path segment carrying an "@" is not mistaken for a credential.
func splitUserinfo(value string) (userinfo, rest string) {
	at := strings.IndexByte(value, '@')
	if at < 0 || strings.Contains(value[:at], "/") {
		return "", value
	}
	return value[:at+1], value[at+1:]
}

// isScpLike reports whether the value is Git's scp-like remote form.
//
// Two shapes qualify: "userinfo@host:path", and the bare "host:path". The
// second has to be told apart from "host:8443/path", where a port is a port and
// not the start of a path — a distinction nothing else in the value reveals.
func isScpLike(value string) bool {
	if at := strings.IndexByte(value, '@'); at >= 0 && !strings.Contains(value[:at], "/") {
		if k := strings.IndexAny(value[at+1:], "/:"); k > 0 && value[at+1+k] == ':' {
			return true
		}
	}
	if c := strings.IndexAny(value, "/:@"); c > 0 && value[c] == ':' {
		return !startsWithPort(value[c+1:])
	}
	return false
}

// startsWithPort reports whether rest begins with digits that end the value or
// are followed by a path separator, which is what a port looks like.
func startsWithPort(rest string) bool {
	digits := 0
	for digits < len(rest) && rest[digits] >= '0' && rest[digits] <= '9' {
		digits++
	}
	return digits > 0 && (digits == len(rest) || rest[digits] == '/')
}

// splitPort separates a trailing ":port" of one to five digits from a host.
func splitPort(host string) (name, port string, ok bool) {
	colon := strings.LastIndexByte(host, ':')
	if colon <= 0 || colon == len(host)-1 {
		return host, "", false
	}
	port = host[colon+1:]
	if len(port) > 5 {
		return host, "", false
	}
	for index := 0; index < len(port); index++ {
		if port[index] < '0' || port[index] > '9' {
			return host, "", false
		}
	}
	return host[:colon], port, true
}

// trimGitSuffix removes a case-insensitive ".git" from the last path segment,
// because repo and repo.git are the same repository under every forge.
func trimGitSuffix(segment string) string {
	if len(segment) >= 4 && strings.EqualFold(segment[len(segment)-4:], ".git") {
		return segment[:len(segment)-4]
	}
	return segment
}

// isECMAScriptSpace reports the characters String.prototype.trim removes and
// the ECMAScript \s class matches.
//
// The set is spelled out rather than delegated to unicode.IsSpace because the
// two differ at the edges — Go counts U+0085 and JavaScript does not, and
// JavaScript counts U+FEFF and Go does not — and a value trimmed differently in
// the two languages would canonicalise differently or be refused for a
// different reason.
func isECMAScriptSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ',
		0x00a0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

// isForbiddenInCloneURL matches the ECMAScript class [\s\x00-\x1f\x7f].
func isForbiddenInCloneURL(r rune) bool {
	return isECMAScriptSpace(r) || r < 0x20 || r == 0x7f
}

// utf16Length counts UTF-16 code units, which is what JavaScript's
// String.prototype.length reports and therefore what the TypeScript bounds
// measure.
func utf16Length(value string) int {
	units := 0
	for _, r := range value {
		units++
		if r > 0xffff {
			units++
		}
	}
	return units
}
