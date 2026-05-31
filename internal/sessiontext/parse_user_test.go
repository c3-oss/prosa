package sessiontext

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestParseUserMessageBareBody(t *testing.T) {
	got := ParseUserMessage("just plain text")
	require.Equal(t, "just plain text", got.Body)
	require.False(t, got.HasExtras())
}

func TestParseUserMessageEmpty(t *testing.T) {
	got := ParseUserMessage("")
	require.True(t, got.IsEmpty())
}

func TestParseUserMessageCommandOnly(t *testing.T) {
	got := ParseUserMessage("<command-name>/model</command-name>")
	require.Equal(t, "/model", got.Command)
	require.Empty(t, got.Body)
}

func TestParseUserMessageCommandWithArgsAndMessage(t *testing.T) {
	in := strings.Join([]string{
		"<command-name>/model</command-name>",
		"<command-message>model</command-message>",
		"<command-args></command-args>",
	}, "\n")
	got := ParseUserMessage(in)
	require.Equal(t, "/model", got.Command)
	require.Equal(t, "model", got.CommandMessage)
	require.Empty(t, got.CommandArgs)
}

func TestParseUserMessageSystemReminder(t *testing.T) {
	in := "before <system-reminder>be careful</system-reminder> after"
	got := ParseUserMessage(in)
	require.Equal(t, []string{"be careful"}, got.Reminders)
	require.Equal(t, "before  after", got.Body)
}

func TestParseUserMessageMultipleReminders(t *testing.T) {
	in := strings.Join([]string{
		"<system-reminder>first reminder</system-reminder>",
		"<system-reminder>second reminder</system-reminder>",
		"<system-reminder>third reminder</system-reminder>",
		"the actual prompt",
	}, "\n")
	got := ParseUserMessage(in)
	require.Equal(t, []string{"first reminder", "second reminder", "third reminder"}, got.Reminders)
	require.Equal(t, "the actual prompt", got.Body)
}

func TestParseUserMessageLocalCommandStdout(t *testing.T) {
	in := "<local-command-stdout>line one\nline two</local-command-stdout>\nbody here"
	got := ParseUserMessage(in)
	require.Equal(t, "line one\nline two", got.LocalCommandStdout)
	require.Equal(t, "body here", got.Body)
}

func TestParseUserMessageEnvContext(t *testing.T) {
	in := "<environment_context>OS: macOS</environment_context>real prompt"
	got := ParseUserMessage(in)
	require.Equal(t, "OS: macOS", got.EnvContext)
	require.Equal(t, "real prompt", got.Body)
}

func TestParseUserMessageMixedRealistic(t *testing.T) {
	in := strings.Join([]string{
		"<command-name>/clear</command-name>",
		"<command-message>clear</command-message>",
		"<command-args></command-args>",
		"<system-reminder>previous context dropped</system-reminder>",
		"<local-command-stdout>chat cleared</local-command-stdout>",
		"Hello, please help me debug.",
	}, "\n")
	got := ParseUserMessage(in)
	require.Equal(t, "/clear", got.Command)
	require.Equal(t, "clear", got.CommandMessage)
	require.Equal(t, "", got.CommandArgs)
	require.Equal(t, []string{"previous context dropped"}, got.Reminders)
	require.Equal(t, "chat cleared", got.LocalCommandStdout)
	require.Equal(t, "Hello, please help me debug.", got.Body)
}

func TestParseUserMessageMalformedKeepsOpenTagInBody(t *testing.T) {
	// Open tag without a matching close — parser should leave it in
	// the body rather than swallow the rest of the message.
	in := "<system-reminder>oops never closed"
	got := ParseUserMessage(in)
	require.Empty(t, got.Reminders)
	require.Equal(t, "<system-reminder>oops never closed", got.Body)
}

func TestParseUserMessagePermissionsInstructionsPrefix(t *testing.T) {
	// <permissions instructions> has no closer; it runs until the
	// next known wrapper (or end of input).
	in := "<permissions instructions>You may not write files." +
		"<system-reminder>be terse</system-reminder>" +
		"Now do the thing."
	got := ParseUserMessage(in)
	require.Equal(t, "You may not write files.", got.PermissionsInstructions)
	require.Equal(t, []string{"be terse"}, got.Reminders)
	require.Equal(t, "Now do the thing.", got.Body)
}

func TestParseUserMessageStripsAnsiBeforeParsing(t *testing.T) {
	// SanitizeForDisplay runs first, so an ANSI-laden stdout wrapper
	// still matches and the inner text is clean.
	in := "<local-command-stdout>\x1b[1mok\x1b[22m\n</local-command-stdout>after"
	got := ParseUserMessage(in)
	require.Equal(t, "ok", got.LocalCommandStdout)
	require.Equal(t, "after", got.Body)
}

func TestParseUserMessageHasExtras(t *testing.T) {
	require.False(t, ParseUserMessage("hi").HasExtras())
	require.True(t, ParseUserMessage("<command-name>/x</command-name>").HasExtras())
	require.True(t, ParseUserMessage("<system-reminder>r</system-reminder>body").HasExtras())
}
