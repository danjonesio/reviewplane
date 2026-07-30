package gatewayhttp

import (
	"sync"
	"time"

	"github.com/danjonesio/reviewplane/services/tunnel-gateway/datachannel"
)

// Channels holds the connector data channels the gateway has terminated.
//
// One connector has at most one data channel. A second channel for the same
// identity replaces the first, and the first is closed: a connector that
// reconnects after a network drop must not leave a half-dead session that a
// route still resolves to, and two live channels for one identity would make
// which one carries a stream a race.
type Channels struct {
	mu       sync.RWMutex
	sessions map[string]*channel
}

type channel struct {
	session     *datachannel.Session
	connectedAt time.Time
	remote      string
}

// NewChannels builds an empty channel set.
func NewChannels() *Channels {
	return &Channels{sessions: map[string]*channel{}}
}

// Put registers a connector's channel, closing any channel it replaces.
func (c *Channels) Put(connectorID string, session *datachannel.Session, remote string, now time.Time) {
	c.mu.Lock()
	previous := c.sessions[connectorID]
	c.sessions[connectorID] = &channel{session: session, connectedAt: now, remote: remote}
	c.mu.Unlock()
	if previous != nil {
		previous.session.Close(errReplacedChannel)
	}
}

// Remove drops a channel if it is still the current one for that connector.
func (c *Channels) Remove(connectorID string, session *datachannel.Session) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if existing, ok := c.sessions[connectorID]; ok && existing.session == session {
		delete(c.sessions, connectorID)
	}
}

// Get returns the live channel for a connector.
func (c *Channels) Get(connectorID string) (*datachannel.Session, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	existing, ok := c.sessions[connectorID]
	if !ok {
		return nil, false
	}
	select {
	case <-existing.session.Done():
		return nil, false
	default:
	}
	return existing.session, true
}

// Count reports how many channels are open.
func (c *Channels) Count() int {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return len(c.sessions)
}

// CloseConnector ends a connector's channel, which is how identity revocation
// (docs/CONNECTOR_PROTOCOL.md section 18) reaches the data plane.
func (c *Channels) CloseConnector(connectorID string, cause error) bool {
	c.mu.Lock()
	existing, ok := c.sessions[connectorID]
	if ok {
		delete(c.sessions, connectorID)
	}
	c.mu.Unlock()
	if !ok {
		return false
	}
	existing.session.Close(cause)
	return true
}

// CloseAll ends every channel, for shutdown.
func (c *Channels) CloseAll(cause error) {
	c.mu.Lock()
	sessions := make([]*datachannel.Session, 0, len(c.sessions))
	for _, existing := range c.sessions {
		sessions = append(sessions, existing.session)
	}
	c.sessions = map[string]*channel{}
	c.mu.Unlock()
	for _, session := range sessions {
		session.Close(cause)
	}
}

// EnforceDeadlines runs stream deadline enforcement across every channel.
func (c *Channels) EnforceDeadlines(now time.Time) int {
	c.mu.RLock()
	sessions := make([]*datachannel.Session, 0, len(c.sessions))
	for _, existing := range c.sessions {
		sessions = append(sessions, existing.session)
	}
	c.mu.RUnlock()
	closed := 0
	for _, session := range sessions {
		closed += session.EnforceDeadlines(now)
	}
	return closed
}
