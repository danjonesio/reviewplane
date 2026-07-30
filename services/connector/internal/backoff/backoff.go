// Package backoff implements the jittered bounded reconnect backoff required by
// docs/DEVELOPMENT.md section 10 and docs/ARCHITECTURE.md section 14
// ("attempt bounded reconnect").
//
// Two properties matter and are tested directly: the delay never exceeds the
// configured maximum, and the jitter is applied per attempt so that a fleet of
// connectors that lost the control plane at the same moment does not return in
// lockstep.
package backoff

import (
	"context"
	"math"
	"math/rand/v2"
	"time"
)

// Policy is an exponential backoff with proportional jitter.
type Policy struct {
	// Initial is the delay before the first retry.
	Initial time.Duration
	// Max bounds every delay.
	Max time.Duration
	// Factor multiplies the delay for each successive attempt.
	Factor float64
	// Jitter is the proportion of the base delay the result may vary by, in
	// [0, 1]. 0.3 spreads a delay across ±30 per cent.
	Jitter float64
}

// Base is the un-jittered delay for a one-based attempt number, bounded by Max.
func (p Policy) Base(attempt int) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	factor := p.Factor
	if factor < 1 {
		factor = 1
	}
	scaled := float64(p.Initial) * math.Pow(factor, float64(attempt-1))
	if math.IsInf(scaled, 0) || scaled > float64(p.Max) {
		return p.Max
	}
	return time.Duration(scaled)
}

// DelayWith computes the delay for a one-based attempt number using a supplied
// uniform sample in [0, 1). It exists so that the jitter bounds can be tested
// without depending on a random source.
func (p Policy) DelayWith(attempt int, sample float64) time.Duration {
	base := p.Base(attempt)
	jitter := p.Jitter
	switch {
	case jitter < 0:
		jitter = 0
	case jitter > 1:
		jitter = 1
	}
	if jitter == 0 {
		return clamp(base, p.Max)
	}
	switch {
	case sample < 0:
		sample = 0
	case sample >= 1:
		sample = math.Nextafter(1, 0)
	}
	// Map the sample onto [-jitter, +jitter] of the base delay.
	offset := (sample*2 - 1) * jitter
	return clamp(time.Duration(float64(base)*(1+offset)), p.Max)
}

// Delay computes the delay for a one-based attempt number.
func (p Policy) Delay(attempt int) time.Duration {
	return p.DelayWith(attempt, rand.Float64()) // #nosec G404 -- jitter, not a security decision
}

func clamp(value, maximum time.Duration) time.Duration {
	switch {
	case value < 0:
		return 0
	case maximum > 0 && value > maximum:
		return maximum
	default:
		return value
	}
}

// Sleep waits for the attempt's delay or until ctx is done, and reports the
// delay it used. It returns ctx.Err() when the wait was interrupted.
func (p Policy) Sleep(ctx context.Context, attempt int) (time.Duration, error) {
	delay := p.Delay(attempt)
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return delay, ctx.Err()
	case <-timer.C:
		return delay, nil
	}
}
