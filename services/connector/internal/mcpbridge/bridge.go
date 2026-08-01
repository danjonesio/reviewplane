// Package mcpbridge is the local MCP bridge of docs/CONNECTOR_PROTOCOL.md
// section 14 and docs/MCP_SPEC.md section 3.1.
//
// It does three things and refuses to do a fourth.
//
// It exchanges the connector's X.509 device identity for a short-lived agent
// credential bound to one project (ADR-0023). It proxies JSON-RPC between the
// agent's stdin and stdout and the control plane's MCP endpoint. And it reports
// newly assigned work as a local notification (section 16).
//
// The fourth is storage. The credential lives in this process's memory for the
// life of the command and is written nowhere: not to the identity directory,
// not to a cache, not to a log line. Section 14 requires the bridge to "avoid
// storing long-lived agent tokens", and the strongest form of that is a program
// with no code path that writes one. A connector restart ends this process, and
// the next bridge asks for a fresh credential.
//
// The bridge holds no listening socket. It reads stdin and writes stdout, which
// is what makes it usable as a stdio MCP server and what keeps the development
// machine's ports unexposed (docs/SECURITY.md section 9).
package mcpbridge

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// MaxMessageBytes bounds one JSON-RPC message in either direction.
//
// It is the MCP request bound of packages/protocol/schemas/mcp/v1.schema.json
// rounded up to the transport's own body limit. A peer outside the trust
// boundary must not be able to stop this process with one message (ADR-0022),
// so an oversized line is refused rather than buffered without limit.
const MaxMessageBytes = 1 << 20

// ExchangeTimeout bounds the credential request.
const ExchangeTimeout = 30 * time.Second

// RequestTimeout bounds one proxied JSON-RPC call.
const RequestTimeout = 120 * time.Second

// Credential is a short-lived agent credential and the context it was issued
// for. It is a value rather than a stored record: nothing here is persisted.
type Credential struct {
	Token            string
	CredentialID     string
	ProjectID        string
	ProjectSlug      string
	WorkspaceID      string
	Branch           string
	HeadCommit       string
	Capabilities     []string
	ExpiresAt        time.Time
	ExpiresInSeconds int
	// PendingWork is what the connector reports as a local notification
	// (docs/CONNECTOR_PROTOCOL.md section 16). It is bounded by the control
	// plane and names the work rather than carrying it.
	PendingWork []Work
}

// String deliberately omits the token.
//
// A credential that renders itself into a log line is a credential in a log
// file (docs/SECURITY.md section 18), and this type is passed to a logger.
func (c Credential) String() string {
	return fmt.Sprintf("agent credential %s for project %s expiring %s",
		c.CredentialID, c.ProjectSlug, c.ExpiresAt.Format(time.RFC3339))
}

// ExchangeOptions is what the credential request needs.
type ExchangeOptions struct {
	// ControlURL is the connector control endpoint from the identity record,
	// which names the host and port of the mutually authenticated listener.
	ControlURL string
	// WorkspacePathHash is the sha256: digest of the checkout's absolute path,
	// which is how the control plane resolves the workspace inside this
	// connector's own environment.
	WorkspacePathHash string
	CAFile            string
	ClientCertificate *tls.Certificate
	UserAgent         string
}

// ErrRefused reports a credential exchange the control plane declined.
var ErrRefused = errors.New("mcpbridge: the control plane refused the credential request")

// credentialEndpoint derives the exchange URL from the control endpoint.
//
// The identity record carries a wss:// control URL rather than a base address,
// so the scheme is rewritten and the path replaced. Deriving it keeps the two
// on one host and port by construction: a bridge that could be pointed at a
// different host than the connector's own channel would be a second trust
// anchor to get wrong.
func credentialEndpoint(controlURL string) (string, error) {
	parsed, err := url.Parse(controlURL)
	if err != nil {
		return "", fmt.Errorf("mcpbridge: the identity record's control_url is not a URL: %w", err)
	}
	switch parsed.Scheme {
	case "wss", "https":
		parsed.Scheme = "https"
	default:
		return "", fmt.Errorf("mcpbridge: refusing a control_url with scheme %q; only wss and https are accepted", parsed.Scheme)
	}
	parsed.Path = "/connector/v1/agent-credentials"
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return parsed.String(), nil
}

type exchangeResponse struct {
	Data struct {
		Token            string   `json:"token"`
		CredentialID     string   `json:"credential_id"`
		ProjectID        string   `json:"project_id"`
		ProjectSlug      string   `json:"project_slug"`
		WorkspaceID      string   `json:"workspace_id"`
		Branch           string   `json:"branch"`
		HeadCommit       string   `json:"head_commit"`
		Capabilities     []string `json:"capabilities"`
		ExpiresAt        string   `json:"expires_at"`
		ExpiresInSeconds int      `json:"expires_in_seconds"`
		PendingWork      []struct {
			Type         string `json:"type"`
			ReviewSlug   string `json:"review_slug"`
			FindingCount int    `json:"finding_count"`
			Priority     string `json:"priority"`
		} `json:"pending_work"`
	} `json:"data"`
	Error *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

// Exchange requests a short-lived agent credential.
//
// The request presents the connector's client certificate and names only the
// workspace's path hash. The control plane decides the project from it, so the
// bridge cannot ask for a project it is not in.
func Exchange(ctx context.Context, options ExchangeOptions) (Credential, error) {
	endpoint, err := credentialEndpoint(options.ControlURL)
	if err != nil {
		return Credential{}, err
	}
	client, err := newHTTPClient(options.CAFile, options.ClientCertificate)
	if err != nil {
		return Credential{}, err
	}
	defer client.CloseIdleConnections()

	body := fmt.Sprintf(`{"workspace_path_hash":%q}`, options.WorkspacePathHash)
	attemptCtx, cancel := context.WithTimeout(ctx, ExchangeTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(attemptCtx, http.MethodPost, endpoint, strings.NewReader(body))
	if err != nil {
		return Credential{}, fmt.Errorf("mcpbridge: building the credential request: %w", err)
	}
	request.Header.Set("content-type", "application/json")
	request.Header.Set("accept", "application/json")
	if options.UserAgent != "" {
		request.Header.Set("user-agent", options.UserAgent)
	}

	response, err := client.Do(request)
	if err != nil {
		return Credential{}, fmt.Errorf("mcpbridge: requesting an agent credential: %w", err)
	}
	defer func() { _ = response.Body.Close() }()

	raw, err := io.ReadAll(io.LimitReader(response.Body, MaxMessageBytes))
	if err != nil {
		return Credential{}, fmt.Errorf("mcpbridge: reading the credential response: %w", err)
	}
	decoded, err := decodeExchange(raw)
	if err != nil {
		return Credential{}, err
	}
	if response.StatusCode != http.StatusCreated {
		code := "UNKNOWN"
		message := "no reason was given"
		if decoded.Error != nil {
			code = decoded.Error.Code
			message = decoded.Error.Message
		}
		return Credential{}, fmt.Errorf("%w: %s: %s", ErrRefused, code, message)
	}
	expires, err := time.Parse(time.RFC3339, decoded.Data.ExpiresAt)
	if err != nil {
		return Credential{}, fmt.Errorf("mcpbridge: the credential expiry is not a timestamp: %w", err)
	}
	if decoded.Data.Token == "" {
		return Credential{}, errors.New("mcpbridge: the control plane returned no token")
	}
	work := make([]Work, 0, len(decoded.Data.PendingWork))
	for _, item := range decoded.Data.PendingWork {
		work = append(work, Work{
			Type:         item.Type,
			ReviewSlug:   item.ReviewSlug,
			FindingCount: item.FindingCount,
			Priority:     item.Priority,
		})
	}
	return Credential{
		PendingWork:      work,
		Token:            decoded.Data.Token,
		CredentialID:     decoded.Data.CredentialID,
		ProjectID:        decoded.Data.ProjectID,
		ProjectSlug:      decoded.Data.ProjectSlug,
		WorkspaceID:      decoded.Data.WorkspaceID,
		Branch:           decoded.Data.Branch,
		HeadCommit:       decoded.Data.HeadCommit,
		Capabilities:     decoded.Data.Capabilities,
		ExpiresAt:        expires,
		ExpiresInSeconds: decoded.Data.ExpiresInSeconds,
	}, nil
}

// ProxyOptions is what the stdio proxy needs.
type ProxyOptions struct {
	// Endpoint is the control plane's MCP endpoint, already carrying the
	// session-scoped query parameters of docs/MCP_SPEC.md section 3.2.
	Endpoint string
	Token    string
	CAFile   string
	// In and Out are the agent's stdin and stdout. Nothing else is written to
	// Out: it is the JSON-RPC channel, and a stray diagnostic on it would
	// corrupt the stream a client is parsing.
	In        io.Reader
	Out       io.Writer
	UserAgent string
	Logger    *slog.Logger
}

// MCPEndpoint builds the endpoint URL for one bridge session.
//
// The hints ride on the query string because MCP's own handshake has nowhere to
// carry them (docs/MCP_SPEC.md section 3.2). The credential does **not**: it
// travels in an Authorization header, because docs/SECURITY.md section 18
// forbids a credential in a URL.
func MCPEndpoint(base string, projectSlug string, workspacePath string) (string, error) {
	parsed, err := url.Parse(base)
	if err != nil {
		return "", fmt.Errorf("mcpbridge: the control-plane URL is not a URL: %w", err)
	}
	if parsed.Scheme != "https" {
		return "", fmt.Errorf("mcpbridge: refusing a control-plane URL with scheme %q; only https is accepted", parsed.Scheme)
	}
	parsed.Path = "/mcp/v1"
	query := url.Values{}
	if projectSlug != "" {
		query.Set("project_hint", projectSlug)
	}
	if workspacePath != "" {
		query.Set("workspace_hint", workspacePath)
	}
	parsed.RawQuery = query.Encode()
	parsed.Fragment = ""
	return parsed.String(), nil
}

// Proxy carries newline-delimited JSON-RPC between the agent and the endpoint.
//
// Each message the agent writes becomes one POST; the response body is written
// back as one line. The MCP session identifier the endpoint mints is captured
// from the first response and echoed on every later request, which is what
// makes this one session rather than a sequence of unrelated ones.
//
// A message the endpoint refuses below the envelope is reported to the agent as
// a JSON-RPC error rather than by closing the connection: a transport failure
// and a refusal look different to a client, and conflating them would make
// every refusal look like a broken bridge.
func Proxy(ctx context.Context, options ProxyOptions) error {
	client, err := newHTTPClient(options.CAFile, nil)
	if err != nil {
		return err
	}
	defer client.CloseIdleConnections()

	reader := bufio.NewReaderSize(options.In, 64*1024)
	var sessionMu sync.Mutex
	sessionID := ""

	for {
		line, err := readBoundedLine(reader)
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		if err := ctx.Err(); err != nil {
			return err
		}

		callCtx, cancel := context.WithTimeout(ctx, RequestTimeout)
		request, buildErr := http.NewRequestWithContext(
			callCtx, http.MethodPost, options.Endpoint, bytes.NewReader(line),
		)
		if buildErr != nil {
			cancel()
			return fmt.Errorf("mcpbridge: building the proxied request: %w", buildErr)
		}
		request.Header.Set("content-type", "application/json")
		request.Header.Set("accept", "application/json, text/event-stream")
		request.Header.Set("authorization", "Bearer "+options.Token)
		if options.UserAgent != "" {
			request.Header.Set("user-agent", options.UserAgent)
		}
		sessionMu.Lock()
		if sessionID != "" {
			request.Header.Set("mcp-session-id", sessionID)
		}
		sessionMu.Unlock()

		response, callErr := client.Do(request)
		if callErr != nil {
			cancel()
			// The control plane went away mid-session. The agent is told in its
			// own protocol rather than by the pipe closing under it.
			if writeErr := writeTransportError(options.Out, line, callErr); writeErr != nil {
				return writeErr
			}
			continue
		}
		if minted := response.Header.Get("mcp-session-id"); minted != "" {
			sessionMu.Lock()
			sessionID = minted
			sessionMu.Unlock()
		}
		body, readErr := io.ReadAll(io.LimitReader(response.Body, MaxMessageBytes))
		_ = response.Body.Close()
		cancel()
		if readErr != nil {
			if writeErr := writeTransportError(options.Out, line, readErr); writeErr != nil {
				return writeErr
			}
			continue
		}
		if len(bytes.TrimSpace(body)) == 0 {
			// A notification produced no response. Nothing is written back:
			// JSON-RPC notifications have no reply, and inventing one would
			// desynchronise the client's request table.
			continue
		}
		if _, err := options.Out.Write(append(bytes.TrimRight(body, "\r\n"), '\n')); err != nil {
			return fmt.Errorf("mcpbridge: writing to the agent: %w", err)
		}
	}
}

// readBoundedLine reads one newline-delimited message, refusing an oversized
// one rather than growing without limit.
func readBoundedLine(reader *bufio.Reader) ([]byte, error) {
	var buffer bytes.Buffer
	for {
		chunk, isPrefix, err := reader.ReadLine()
		if err != nil {
			return nil, err
		}
		if buffer.Len()+len(chunk) > MaxMessageBytes {
			return nil, fmt.Errorf("mcpbridge: a message exceeded the %d byte bound", MaxMessageBytes)
		}
		buffer.Write(chunk)
		if !isPrefix {
			return buffer.Bytes(), nil
		}
	}
}
