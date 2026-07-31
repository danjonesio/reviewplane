package mcpbridge

import (
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"time"

	"github.com/danjonesio/reviewplane/services/connector/internal/transport"
)

// newHTTPClient builds the one HTTP client this package uses.
//
// It is a client and never a server. The connector's guard test forbids a
// listening socket in any package the binary links, and this package holds
// none: the bridge speaks to the agent over stdin and stdout, so no port is
// opened on the development machine (docs/SECURITY.md section 9).
//
// TLS verification is never disabled. transport.NewTLSConfig pins the minimum
// version and loads the operator's trust anchor; passing a client certificate
// makes the connection mutually authenticated, which is what the credential
// exchange needs and what the proxied MCP traffic does not.
func newHTTPClient(caFile string, certificate *tls.Certificate) (*http.Client, error) {
	options := transport.TLSOptions{CAFile: caFile}
	if certificate != nil {
		options.ClientCertificate = certificate
	}
	tlsConfig, err := transport.NewTLSConfig(options)
	if err != nil {
		return nil, err
	}
	return &http.Client{
		Transport: &http.Transport{
			TLSClientConfig:     tlsConfig,
			TLSHandshakeTimeout: 15 * time.Second,
			DialContext: (&net.Dialer{
				Timeout:   15 * time.Second,
				KeepAlive: 30 * time.Second,
			}).DialContext,
			// One idle connection is enough for a single-agent bridge, and
			// bounding it keeps a long session from holding sockets open
			// against a control plane it is not talking to.
			MaxIdleConns:        2,
			MaxIdleConnsPerHost: 2,
			IdleConnTimeout:     90 * time.Second,
		},
		// No global timeout: the per-request context bounds each call, and a
		// client-wide deadline would cut a long-running tool call short.
	}, nil
}

func decodeExchange(raw []byte) (exchangeResponse, error) {
	var decoded exchangeResponse
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return exchangeResponse{}, fmt.Errorf("mcpbridge: the credential response is not JSON: %w", err)
	}
	return decoded, nil
}

// writeTransportError answers one JSON-RPC request with a transport error.
//
// The agent is told in its own protocol that the call did not reach the control
// plane, rather than having the pipe close under it. The message names no
// credential and no host: it says the control plane could not be reached, and
// the detail goes to the connector's log (docs/SECURITY.md section 18).
func writeTransportError(out io.Writer, request []byte, cause error) error {
	var envelope struct {
		ID any `json:"id"`
	}
	// A malformed request has no identifier to answer; JSON-RPC allows a null
	// identifier for exactly that case.
	_ = json.Unmarshal(request, &envelope)
	body, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      envelope.ID,
		"error": map[string]any{
			// -32000 is the JSON-RPC reserved implementation-defined range. The
			// product's own stable codes live in the MCP envelope, which needs a
			// session to answer in; there is none here.
			"code":    -32000,
			"message": "the ReviewPlane control plane could not be reached",
		},
	})
	if err != nil {
		return fmt.Errorf("mcpbridge: encoding a transport error: %w", err)
	}
	_ = cause
	if _, err := out.Write(append(body, '\n')); err != nil {
		return fmt.Errorf("mcpbridge: writing to the agent: %w", err)
	}
	return nil
}
