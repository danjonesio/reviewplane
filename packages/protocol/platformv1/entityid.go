package platformv1

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"regexp"
)

// Entity identifiers (docs/DOMAIN_MODEL.md section 3).
//
// Two rules make this shared runtime rather than a one-line helper in each
// service.
//
// An identifier encodes nothing. The document forbids encoding tenant,
// timestamp, database sequence or security-sensitive data in an identifier, and
// a consumer that could read a creation time out of one would come to depend on
// it. The suffix here is 128 bits from crypto/rand and nothing else.
//
// A prefix is a debugging convenience, never a check. IdentifierPrefixes
// records the conventional prefix for each entity kind, and IsEntityID
// validates length and character class alone. Nothing here, and nothing that
// reads it, may require a particular prefix.

// EntityIDRandomBytes is the randomness behind every identifier.
const EntityIDRandomBytes = 16

// ErrUnknownEntityKind is returned for a kind the schema names no prefix for.
var ErrUnknownEntityKind = errors.New("platformv1: no identifier prefix is declared for that entity kind")

// ErrIdentifierOutOfBounds is returned when a prefix would produce an
// identifier outside the schema's character class or length bound.
var ErrIdentifierOutOfBounds = errors.New("platformv1: identifier is outside the schema bounds")

// identifierPattern mirrors $defs.identifier in the schema source.
var identifierPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// EntityPrefix returns the conventional prefix for an entity kind, including
// its underscore.
func EntityPrefix(kind string) (string, error) {
	prefix, ok := IdentifierPrefixes[kind]
	if !ok {
		return "", ErrUnknownEntityKind
	}
	return prefix, nil
}

func randomSuffix() (string, error) {
	buffer := make([]byte, EntityIDRandomBytes)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return hex.EncodeToString(buffer), nil
}

// NewEntityID mints an identifier with the conventional prefix for a kind.
func NewEntityID(kind string) (string, error) {
	prefix, err := EntityPrefix(kind)
	if err != nil {
		return "", err
	}
	return NewPrefixedID(prefix)
}

// NewPrefixedID mints an identifier with a literal prefix. It exists for the
// identifiers another schema source names but this one does not. The prefix is
// not checked against the vocabulary, because checking a prefix is exactly what
// docs/DOMAIN_MODEL.md section 3 forbids a consumer from doing.
func NewPrefixedID(prefix string) (string, error) {
	suffix, err := randomSuffix()
	if err != nil {
		return "", err
	}
	candidate := prefix + suffix
	if !identifierPattern.MatchString(candidate) {
		return "", ErrIdentifierOutOfBounds
	}
	return candidate, nil
}

// IsEntityID reports whether a value satisfies the identifier bounds of the
// schema: length and character class only. A caller that wants to know what an
// identifier refers to must ask the database, not the string.
func IsEntityID(value string) bool {
	return identifierPattern.MatchString(value)
}
