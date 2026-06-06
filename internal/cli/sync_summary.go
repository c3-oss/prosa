package cli

import (
	"fmt"
	"os"
	"strings"

	"github.com/c3-oss/prosa/internal/cli/render"
	"github.com/c3-oss/prosa/pkg/importer"
)

// syncCounts is the tally accumulated across a sync run (local import,
// legacy bundle, inline push, remote catch-up, denoise) and rendered by the
// printSummary* methods below.
type syncCounts struct {
	liveImp, liveSkip, liveErr           int
	legacyImp, legacySkip, legacyErr     int
	pushImp, pushSkip, pushErr           int
	catchUpSent, catchUpSkip, catchUpErr int
	localTotal, remoteTotal              int
	denoiseCleaned                       int
	pushEnabled                          bool
	remoteUnavailable                    bool
	remoteServer                         string
	reconcileRan                         bool
	legacyTotal                          int
	bundlePath                           string
}

func (sc *syncCounts) record(w syncJob, res importer.ImportResult, err error) {
	switch {
	case err != nil:
		if w.legacy {
			sc.legacyErr++
		} else {
			sc.liveErr++
		}
	case res.Skipped:
		if w.legacy {
			sc.legacySkip++
		} else {
			sc.liveSkip++
		}
	default:
		if w.legacy {
			sc.legacyImp++
		} else {
			sc.liveImp++
		}
	}
}

func (sc *syncCounts) recordPush(outcome pushOutcome, err error) {
	if err != nil && outcome != pushFailed {
		outcome = pushFailed
	}
	switch outcome {
	case pushImported:
		sc.pushImp++
	case pushAlreadyHashed, pushSkippedNoUsage:
		sc.pushSkip++
	case pushFailed:
		sc.pushErr++
	}
}

func (sc *syncCounts) recordRemoteUnavailable(push *pusher) {
	if push == nil || !push.remoteUnavailable {
		return
	}
	sc.remoteUnavailable = true
	sc.remoteServer = push.server
}

func (sc *syncCounts) remoteUnavailableText() string {
	server := sc.remoteServer
	if server == "" {
		server = "the configured server"
	}
	return fmt.Sprintf("server unavailable at %s; local import is saved. Run `prosa sync` again when it is back.", server)
}

func (sc *syncCounts) printSummary() {
	fmt.Fprintln(os.Stdout, "prosa sync · complete")
	fmt.Fprintln(os.Stdout)
	fmt.Fprintf(os.Stdout, "Live:     imported %d · skipped %d · errors %d\n",
		sc.liveImp, sc.liveSkip, sc.liveErr)
	if sc.legacyTotal > 0 {
		fmt.Fprintf(os.Stdout, "Legacy:   imported %d · skipped %d · errors %d (of %d catalog rows)\n",
			sc.legacyImp, sc.legacySkip, sc.legacyErr, sc.legacyTotal)
	}
	if sc.pushEnabled {
		fmt.Fprintf(os.Stdout, "Push:     sent %d · skipped %d · errors %d\n",
			sc.pushImp, sc.pushSkip, sc.pushErr)
	}
	if sc.reconcileRan {
		fmt.Fprintf(os.Stdout,
			"Catch-up: sent %d · skipped %d · errors %d  (local %d · remote %d)\n",
			sc.catchUpSent, sc.catchUpSkip, sc.catchUpErr,
			sc.localTotal, sc.remoteTotal)
	}
	if sc.denoiseCleaned > 0 {
		fmt.Fprintf(os.Stdout, "Denoise:  cleaned %d prompts\n", sc.denoiseCleaned)
	}
	if sc.remoteUnavailable {
		fmt.Fprintf(os.Stdout, "Remote:   %s\n", sc.remoteUnavailableText())
	}
	if sc.legacyTotal > 0 {
		fmt.Fprintf(os.Stdout, "\n%s\n", sc.legacySummaryText())
	}
}

func (sc *syncCounts) printSummaryTTY() {
	fmt.Fprintln(os.Stdout)
	fmt.Fprintln(os.Stdout, render.StyleHeader.Render("prosa sync · complete"))
	fmt.Fprintln(os.Stdout)
	printSummaryTTYRow("Live", "imported", sc.liveImp, sc.liveSkip, sc.liveErr, "")
	if sc.legacyTotal > 0 {
		printSummaryTTYRow("Legacy", "imported", sc.legacyImp, sc.legacySkip, sc.legacyErr,
			fmt.Sprintf("of %d catalog rows", sc.legacyTotal))
	}
	if sc.pushEnabled {
		printSummaryTTYRow("Push", "sent", sc.pushImp, sc.pushSkip, sc.pushErr, "")
	}
	if sc.reconcileRan {
		extra := fmt.Sprintf("local %d · remote %d", sc.localTotal, sc.remoteTotal)
		printSummaryTTYRow("Catch-up", "sent", sc.catchUpSent, sc.catchUpSkip, sc.catchUpErr, extra)
	}
	if sc.denoiseCleaned > 0 {
		fmt.Fprintf(
			os.Stdout, "%s %s  %s %d %s\n",
			render.StyleRail.Render("│"),
			render.StyleHeader.Render("Denoise"),
			render.StyleSuccess.Render("cleaned"),
			sc.denoiseCleaned,
			render.StyleMuted.Render("prompts"),
		)
	}
	if sc.remoteUnavailable {
		fmt.Fprintf(
			os.Stdout, "%s %s  %s\n",
			render.StyleRail.Render("│"),
			render.StyleHeader.Render("Remote"),
			render.StyleMuted.Render(sc.remoteUnavailableText()),
		)
	}
	if sc.legacyTotal > 0 {
		fmt.Fprintln(os.Stdout)
		fmt.Fprintf(
			os.Stdout, "%s %s\n",
			render.StyleRail.Render("│"),
			render.StyleMuted.Render(sc.legacySummaryText()),
		)
	}
}

func (sc *syncCounts) legacySummaryText() string {
	if sc.legacyErr > 0 {
		return fmt.Sprintf("Legacy bundle partially mirrored in the prosa store: %s", sc.bundlePath)
	}
	return fmt.Sprintf("Legacy bundle mirrored in the prosa store: %s", sc.bundlePath)
}

func printSummaryTTYRow(label, primaryVerb string, primary, skipped, errs int, extra string) {
	line := fmt.Sprintf(
		"%s %s %s %d · %s %d · %s %d",
		render.StyleRail.Render("│"),
		render.StyleMuted.Render(padSummaryLabel(label)),
		render.StyleSuccess.Render(primaryVerb), primary,
		render.StyleSkipped.Render("skipped"), skipped,
		render.StyleError.Render("errors"), errs,
	)
	if extra != "" {
		line += " · " + render.StyleMuted.Render(extra)
	}
	fmt.Fprintln(os.Stdout, line)
}

func padSummaryLabel(label string) string {
	if len(label) >= 9 {
		return label
	}
	return label + strings.Repeat(" ", 9-len(label))
}
