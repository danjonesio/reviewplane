package backoff

import (
	"context"
	"testing"
	"time"
)

func policy() Policy {
	return Policy{Initial: time.Second, Max: 60 * time.Second, Factor: 2, Jitter: 0.3}
}

func TestBaseGrowsAndIsBounded(t *testing.T) {
	p := policy()
	want := []time.Duration{
		time.Second, 2 * time.Second, 4 * time.Second, 8 * time.Second,
		16 * time.Second, 32 * time.Second, 60 * time.Second, 60 * time.Second,
	}
	for index, expected := range want {
		if got := p.Base(index + 1); got != expected {
			t.Fatalf("Base(%d) = %s, want %s", index+1, got, expected)
		}
	}
	if got := p.Base(1000); got != p.Max {
		t.Fatalf("Base(1000) = %s, want the maximum %s", got, p.Max)
	}
}

// The delay must always land inside the jitter band and never exceed the
// maximum: an unbounded reconnect delay is the failure docs/DEVELOPMENT.md
// section 10 asks the policy to prevent.
func TestDelayStaysInsideTheJitterBand(t *testing.T) {
	p := policy()
	samples := []float64{0, 0.001, 0.25, 0.5, 0.75, 0.999, 1, -1, 2}
	for attempt := 1; attempt <= 12; attempt++ {
		base := p.Base(attempt)
		lower := time.Duration(float64(base) * (1 - p.Jitter))
		upper := time.Duration(float64(base) * (1 + p.Jitter))
		if upper > p.Max {
			upper = p.Max
		}
		for _, sample := range samples {
			delay := p.DelayWith(attempt, sample)
			switch {
			case delay < lower:
				t.Fatalf("attempt %d sample %v: delay %s below the band floor %s", attempt, sample, delay, lower)
			case delay > upper:
				t.Fatalf("attempt %d sample %v: delay %s above the band ceiling %s", attempt, sample, delay, upper)
			case delay > p.Max:
				t.Fatalf("attempt %d sample %v: delay %s exceeds the maximum %s", attempt, sample, delay, p.Max)
			}
		}
	}
}

func TestDelayEdgeSamplesReachBothEnds(t *testing.T) {
	p := policy()
	base := p.Base(3)
	if low := p.DelayWith(3, 0); low != time.Duration(float64(base)*0.7) {
		t.Fatalf("sample 0 delay = %s, want the band floor %s", low, time.Duration(float64(base)*0.7))
	}
	high := p.DelayWith(3, 1)
	if high <= base {
		t.Fatalf("sample 1 delay = %s, want more than the base %s", high, base)
	}
}

func TestZeroJitterIsDeterministic(t *testing.T) {
	p := Policy{Initial: time.Second, Max: 10 * time.Second, Factor: 2}
	for _, sample := range []float64{0, 0.5, 1} {
		if got := p.DelayWith(2, sample); got != 2*time.Second {
			t.Fatalf("DelayWith(2, %v) = %s, want 2s", sample, got)
		}
	}
}

func TestDelayIsRandomised(t *testing.T) {
	p := policy()
	seen := map[time.Duration]bool{}
	for i := 0; i < 32; i++ {
		seen[p.Delay(5)] = true
	}
	if len(seen) < 2 {
		t.Fatal("Delay produced one value across 32 calls; the jitter is not applied")
	}
}

func TestSleepHonoursCancellation(t *testing.T) {
	p := Policy{Initial: time.Hour, Max: time.Hour, Factor: 1}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	started := time.Now()
	if _, err := p.Sleep(ctx, 1); err == nil {
		t.Fatal("Sleep must report the cancellation")
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("Sleep took %s after cancellation", elapsed)
	}
}

func TestSleepWaits(t *testing.T) {
	p := Policy{Initial: 20 * time.Millisecond, Max: 20 * time.Millisecond, Factor: 1}
	started := time.Now()
	delay, err := p.Sleep(context.Background(), 1)
	if err != nil {
		t.Fatalf("Sleep: %v", err)
	}
	if delay != 20*time.Millisecond {
		t.Fatalf("Sleep reported %s", delay)
	}
	if elapsed := time.Since(started); elapsed < 15*time.Millisecond {
		t.Fatalf("Sleep returned after %s", elapsed)
	}
}
