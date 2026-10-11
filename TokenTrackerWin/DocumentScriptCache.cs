namespace TokenTrackerWin;

/// <summary>Only cache a script acknowledged by the current document and latest send.</summary>
internal sealed class DocumentScriptCache
{
    internal readonly record struct Ticket(long Generation, long Revision, string Script);
    private long _generation;
    private long _revision;
    private string? _applied;
    private string? _pending;

    public void Invalidate()
    {
        _generation++;
        _applied = null;
        _pending = null;
    }

    public bool TryStart(string script, out Ticket ticket)
    {
        ticket = default;
        if (script == _applied || script == _pending) return false;
        // An in-flight update may change the page before its acknowledgment.
        _applied = null;
        _pending = script;
        ticket = new Ticket(_generation, ++_revision, script);
        return true;
    }

    public void Complete(Ticket ticket, bool success)
    {
        if (ticket.Generation != _generation || ticket.Revision != _revision) return;
        _pending = null;
        _applied = success ? ticket.Script : null;
    }
}
