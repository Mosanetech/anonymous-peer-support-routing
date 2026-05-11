import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const focusAreas = [
  "Exam pressure",
  "Loneliness",
  "Academic workload",
  "Financial stress",
  "Family pressure",
  "Relationships",
  "Sleep and burnout",
  "Career anxiety"
];

const api = {
  token: localStorage.getItem("peer-support-token") || "",
  async request(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(api.token ? { Authorization: `Bearer ${api.token}` } : {}),
        ...(options.headers || {})
      }
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Request failed.");
    return data;
  },
  setToken(token) {
    api.token = token;
    localStorage.setItem("peer-support-token", token);
  },
  clearToken() {
    api.token = "";
    localStorage.removeItem("peer-support-token");
  }
};

function App() {
  const [user, setUser] = useState(null);
  const [therapist, setTherapist] = useState(null);
  const [group, setGroup] = useState(null);
  const [safeValve, setSafeValve] = useState([]);
  const [activeView, setActiveView] = useState("vent");
  const [loading, setLoading] = useState(Boolean(api.token));
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  async function refresh() {
    const [groupData, safeValveData] = await Promise.all([
      api.request("/api/groups/current"),
      api.request("/api/safe-valve")
    ]);
    setGroup(groupData.group);
    setSafeValve(safeValveData.requests);
  }

  useEffect(() => {
    async function restore() {
      if (!api.token) {
        setLoading(false);
        return;
      }
      try {
        const data = await api.request("/api/me");
        setUser(data.user);
        await refresh();
      } catch {
        try {
          const data = await api.request("/api/therapist/me");
          setTherapist(data.therapist);
        } catch {
          api.clearToken();
        }
      } finally {
        setLoading(false);
      }
    }
    restore();
  }, []);

  useEffect(() => {
    if (!user) return undefined;
    const timer = window.setInterval(() => {
      refresh().catch(() => {});
    }, 3500);
    return () => window.clearInterval(timer);
  }, [user]);

  async function startSession(payload) {
    setError("");
    const data = await api.request("/api/session", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    api.setToken(data.token);
    setUser(data.user);
    await refresh();
  }

  async function therapistLogin(payload) {
    setError("");
    const data = await api.request("/api/therapist/login", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    api.setToken(data.token);
    setTherapist(data.therapist);
  }

  async function joinGroup(payload) {
    setError("");
    setNotice("");
    const data = await api.request("/api/groups/join", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    setGroup(data.group);
    setActiveView("vent");
    setNotice(data.created ? "A new Vent Group was opened for this theme." : "You were routed into a matching Vent Group.");
  }

  async function sendMessage(content, mood) {
    if (!group) return;
    const data = await api.request(`/api/groups/${group.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ content, mood })
    });
    setGroup(data.group);
    if (data.safeValveTriggered) {
      const safeData = await api.request("/api/safe-valve");
      setSafeValve(safeData.requests);
      setNotice("Safe Valve has been opened because this message may need more support than peers can provide.");
    }
  }

  async function leaveGroup() {
    if (!group) return;
    await api.request(`/api/groups/${group.id}/leave`, { method: "POST" });
    setGroup(null);
    setNotice("You left the temporary Vent Group. Your anonymous session is still active.");
  }

  async function createSafeValve(payload) {
    const data = await api.request("/api/safe-valve", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    setSafeValve(data.requests);
    setActiveView("safe");
    setNotice("Safe Valve request created. A support professional can review this queue in the backend.");
  }

  async function sendSafeValveMessage(caseId, content) {
    const data = await api.request(`/api/safe-valve/${caseId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content })
    });
    setSafeValve((current) => current.map((item) => item.id === data.case.id ? data.case : item));
  }

  function logout() {
    api.clearToken();
    setUser(null);
    setTherapist(null);
    setGroup(null);
    setSafeValve([]);
    setActiveView("vent");
    setNotice("");
  }

  if (loading) return <main className="loading-screen">Opening anonymous space...</main>;
  if (therapist) return <TherapistDashboard therapist={therapist} onLogout={logout} />;
  if (!user) return <EntryScreen onStart={startSession} onTherapistLogin={therapistLogin} error={error} setError={setError} />;

  return (
    <main className="app-layout">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span>VG</span>
          <div>
            <strong>Vent Groups</strong>
            <small>{user.alias}</small>
          </div>
        </div>
        <nav>
          {[
            ["vent", "Vent Group"],
            ["match", "Routing"],
            ["safe", "Safe Valve"],
            ["privacy", "Privacy"]
          ].map(([id, label]) => (
            <button key={id} className={activeView === id ? "active" : ""} type="button" onClick={() => setActiveView(id)}>
              {label}
            </button>
          ))}
        </nav>
        <button className="logout-button" type="button" onClick={logout}>End anonymous session</button>
      </aside>

      <section className="content">
        <header className="topbar">
          <div>
            <p className="eyebrow">Anonymous peer-support routing</p>
            <h1>{viewTitle(activeView)}</h1>
          </div>
          <SessionBadge user={user} group={group} />
        </header>
        {notice && <p className="notice-text">{notice}</p>}
        {activeView === "vent" && (
          <VentRoom group={group} user={user} onSend={sendMessage} onLeave={leaveGroup} onRoute={() => setActiveView("match")} />
        )}
        {activeView === "match" && <RoutingView group={group} onJoin={joinGroup} error={error} setError={setError} />}
        {activeView === "safe" && <SafeValveView requests={safeValve} onCreate={createSafeValve} onMessage={sendSafeValveMessage} />}
        {activeView === "privacy" && <PrivacyView user={user} group={group} />}
      </section>
    </main>
  );
}

function viewTitle(view) {
  return {
    vent: "Temporary Vent Group",
    match: "Support Routing",
    safe: "Safe Valve",
    privacy: "Privacy Controls"
  }[view];
}

function EntryScreen({ onStart, onTherapistLogin, error, setError }) {
  const [mode, setMode] = useState("student");
  const [alias, setAlias] = useState("");
  const [intensity, setIntensity] = useState("medium");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  async function submit(event) {
    event.preventDefault();
    setError("");
    try {
      await onStart({ alias, intensity });
    } catch (err) {
      setError(err.message);
    }
  }

  async function submitTherapist(event) {
    event.preventDefault();
    setError("");
    try {
      await onTherapistLogin({ username, password });
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <main className="entry-screen">
      <section className="entry-copy">
        <p className="eyebrow">Private by default</p>
        <h1>Join a small support group without using your real identity.</h1>
        <p>
          Start with an anonymous identifier, choose what you are carrying, and get routed into a temporary Vent Group with students facing similar pressure.
        </p>
      </section>
      <section className="entry-panel">
        <div className="segmented">
          <button className={mode === "student" ? "active" : ""} type="button" onClick={() => setMode("student")}>Student</button>
          <button className={mode === "therapist" ? "active" : ""} type="button" onClick={() => setMode("therapist")}>Therapist</button>
        </div>
        {mode === "student" ? (
        <form className="form-stack" onSubmit={submit}>
        <div className="panel-heading">
          <h2>Anonymous session</h2>
          <p>No email or real name is required for this prototype.</p>
        </div>
        <label>
          Optional alias
          <input value={alias} onChange={(event) => setAlias(event.target.value)} placeholder="Leave blank for auto-generated" maxLength={28} />
        </label>
        <label>
  Current pressure level
  <select value={intensity} onChange={(event) => setIntensity(event.target.value)}>
    <option value="low">Low</option>
    <option value="medium">Medium</option>
    <option value="high">High</option>
  </select>
</label>

<label className="terms-check">
  <input
    type="checkbox"
    checked={acceptedTerms}
    onChange={(event) => setAcceptedTerms(event.target.checked)}
    required
  />
  <span>
    I agree to the anonymous support terms, privacy policy, and understand
    that Echovase is not a replacement for emergency medical services.
  </span>
</label>

<button
  className="primary-button"
  type="submit"
  disabled={!acceptedTerms}
>
  Start anonymously
</button>
        {error && <p className="error-text">{error}</p>}
        </form>
        ) : (
        <form className="form-stack" onSubmit={submitTherapist}>
          <div className="panel-heading">
            <h2>Therapist account</h2>
            
          </div>
          <label>
            Username
            <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" required />
          </label>
          <label>
            Password
            <input value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete="current-password" required />
          </label>
          <button className="primary-button" type="submit">Open support dashboard</button>
          {error && <p className="error-text">{error}</p>}
        </form>
        )}
      </section>
    </main>
  );
}

function SessionBadge({ user, group }) {
  return (
    <div className="session-badge">
      <span>{group ? `${group.participants.length}/${group.capacity} in group` : "Not routed yet"}</span>
      <strong>{user.anonymousId}</strong>
    </div>
  );
}

function RoutingView({ group, onJoin, error, setError }) {
  const [selected, setSelected] = useState("Exam pressure");
  const [intensity, setIntensity] = useState("medium");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onJoin({ topics: [selected], intensity, note });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="view-stack">
      <section className="metric-grid">
        <Metric title="Group size" value="3 to 5" />
        <Metric title="Session lifetime" value="3 days" />
        <Metric title="Identity mode" value="Anonymous" />
      </section>
      <form className="panel form-stack" onSubmit={submit}>
        <div className="panel-heading">
          <h2>Route me to peers</h2>
          <p>Pick the themes that best match what you want to discuss.</p>
        </div>
        <div className="topic-grid">
          {focusAreas.map((topic) => (
            <label className="topic-option" key={topic}>
              <input
                type="radio"
                name="support-topic"
                checked={selected === topic}
                onChange={() => setSelected(topic)}
              />
              <span>{topic}</span>
            </label>
          ))}
        </div>
        <label>
          Intensity
          <select value={intensity} onChange={(event) => setIntensity(event.target.value)}>
            <option value="low">Low pressure</option>
            <option value="medium">Moderate pressure</option>
            <option value="high">High pressure</option>
          </select>
        </label>
        <label>
          Context note
          <textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Share a short context note for routing only." maxLength={220} />
        </label>
        <button className="primary-button" type="submit" disabled={busy || selected.length === 0}>
          {busy ? "Routing..." : group ? "Find another group" : "Join Vent Group"}
        </button>
        {error && <p className="error-text">{error}</p>}
      </form>
    </div>
  );
}

function VentRoom({ group, user, onSend, onLeave, onRoute }) {
  const [message, setMessage] = useState("");
  const [mood, setMood] = useState("steady");
  const messages = group?.messages || [];

  async function submit(event) {
    event.preventDefault();
    const trimmed = message.trim();
    if (!trimmed) return;
    await onSend(trimmed, mood);
    setMessage("");
  }

  if (!group) {
    return (
      <section className="empty-room">
        <div>
          <p className="eyebrow">No active group</p>
          <h2>Choose a theme to be routed into a temporary Vent Group.</h2>
          <p>Groups are small, anonymous, and expire automatically.</p>
        </div>
        <button className="primary-button" type="button" onClick={onRoute}>Start routing</button>
      </section>
    );
  }

  return (
    <div className="room-layout">
      <section className="chat-panel">
        <div className="room-header">
          <div>
            <p className="eyebrow">Vent Group</p>
            <h2>{group.name}</h2>
            <p>{group.topics.join(", ")}</p>
          </div>
          <button className="secondary-button" type="button" onClick={onLeave}>Leave</button>
        </div>
        <div className="message-list">
          {messages.map((item) => (
            <article className={`message ${item.senderId === user.id ? "mine" : ""} ${item.type === "system" ? "system" : ""}`} key={item.id}>
              <header>
                <strong>{item.senderAlias}</strong>
                <span>{new Date(item.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
              </header>
              <p>{item.content}</p>
              {item.mood && <small>{item.mood}</small>}
            </article>
          ))}
          {!messages.length && <p className="empty-text">No messages yet. Start with what feels safe to share.</p>}
        </div>
        <form className="composer" onSubmit={submit}>
          <select value={mood} onChange={(event) => setMood(event.target.value)} aria-label="Mood">
            <option value="steady">Steady</option>
            <option value="overwhelmed">Overwhelmed</option>
            <option value="tired">Tired</option>
            <option value="hopeful">Hopeful</option>
          </select>
          <input value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Write anonymously..." maxLength={700} />
          <button className="primary-button" type="submit">Send</button>
        </form>
      </section>
      <GroupPanel group={group} />
    </div>
  );
}

function GroupPanel({ group }) {
  const expiresIn = useMemo(() => {
    const remainingMs = new Date(group.expiresAt) - Date.now();

    const days = Math.max(0, Math.ceil(remainingMs / (1000 * 60 * 60 * 24)));

    return `${days} day${days !== 1 ? "s" : ""}`;
  }, [group.expiresAt, group.messages.length]);
  return (
    <aside className="side-panel">
      <div className="panel-heading">
        <h2>Session status</h2>
        <p>Temporary support room</p>
      </div>
      <dl className="status-list">
        <div><dt>Expires in</dt><dd>{expiresIn}</dd></div>
        <div><dt>Participants</dt><dd>{group.participants.length}</dd></div>
        <div><dt>Intensity</dt><dd>{group.intensity}</dd></div>
      </dl>
      <div className="participant-list">
        {group.participants.map((participant) => (
          <span key={participant.id}>{participant.alias}</span>
        ))}
      </div>
    </aside>
  );
}

function SafeValveView({ requests, onCreate, onMessage }) {
  const [reason, setReason] = useState("I need professional support");
  const [contactPreference, setContactPreference] = useState("in-app follow-up");
  const [urgency, setUrgency] = useState("normal");
  const [details, setDetails] = useState("");
  const [activeCaseId, setActiveCaseId] = useState("");
  const activeCase = requests.find((request) => request.id === activeCaseId) || requests[0];

  async function submit(event) {
    event.preventDefault();
    await onCreate({ reason, contactPreference, urgency, details });
    setDetails("");
  }

  return (
    <section className="split-grid">
      <form className="panel form-stack" onSubmit={submit}>
        <div className="panel-heading">
          <h2>Request extra support</h2>
          <p>Use this when the situation needs a qualified therapist or support professional.</p>
        </div>
        <label>
          Reason
          <select value={reason} onChange={(event) => setReason(event.target.value)}>
            <option>I need professional support</option>
            <option>I may be at risk</option>
            <option>A peer may be at risk</option>
            <option>I need academic crisis support</option>
          </select>
        </label>
        <label>
          Preferred follow-up
          <select value={contactPreference} onChange={(event) => setContactPreference(event.target.value)}>
            <option>in-app follow-up</option>
            <option>campus counsellor referral</option>
            <option>ICT therapist queue</option>
          </select>
        </label>
        <label>
          Urgency
          <select value={urgency} onChange={(event) => setUrgency(event.target.value)}>
            <option value="normal">Normal</option>
            <option value="same-day">Same-day support</option>
            <option value="urgent">Urgent</option>
          </select>
        </label>
        <label>
          Details
          <textarea value={details} onChange={(event) => setDetails(event.target.value)} placeholder="Describe what support is needed." maxLength={500} required />
        </label>
        <button className="primary-button" type="submit">Open Safe Valve</button>
      </form>
      <article className="panel">
        <div className="panel-heading">
          <h2>My Safe Valve requests</h2>
          <p>Requests are linked to your anonymous session identifier.</p>
        </div>
        <div className="request-list">
          {requests.map((request) => (
            <button className={`request-item ${activeCase?.id === request.id ? "active" : ""}`} type="button" key={request.id} onClick={() => setActiveCaseId(request.id)}>
              <strong>{request.reason}</strong>
              <span>{request.status} {request.assignedTherapistName ? `- ${request.assignedTherapistName}` : ""}</span>
              <p>{request.details}</p>
            </button>
          ))}
          {!requests.length && <p className="empty-text">No Safe Valve requests yet.</p>}
        </div>
      </article>
      {activeCase && <SafeValveCaseChat activeCase={activeCase} onMessage={onMessage} />}
    </section>
  );
}

function SafeValveCaseChat({ activeCase, onMessage }) {
  const [content, setContent] = useState("");

  async function submit(event) {
    event.preventDefault();
    if (!content.trim()) return;
    await onMessage(activeCase.id, content);
    setContent("");
  }

  return (
    <article className="panel case-chat-panel">
      <div className="panel-heading">
        <h2>Private support chat</h2>
        <p>{activeCase.assignedTherapistName ? `Assigned to ${activeCase.assignedTherapistName}` : "Waiting for therapist assignment"}</p>
      </div>
      <div className="case-message-list">
        {(activeCase.messages || []).map((message) => (
          <div className={`case-message ${message.senderType}`} key={message.id}>
            <strong>{message.senderName}</strong>
            <p>{message.content}</p>
          </div>
        ))}
      </div>
      <form className="composer case-composer" onSubmit={submit}>
        <input value={content} onChange={(event) => setContent(event.target.value)} placeholder="Message your assigned support professional..." />
        <button className="primary-button" type="submit">Send</button>
      </form>
    </article>
  );
}

function TherapistDashboard({ therapist, onLogout }) {
  const [cases, setCases] = useState([]);
  const [activeCaseId, setActiveCaseId] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const activeCase = cases.find((item) => item.id === activeCaseId) || cases[0];

  async function loadCases() {
    const data = await api.request("/api/therapist/cases");
    setCases(data.cases);
  }

  useEffect(() => {
    loadCases().catch((err) => setError(err.message));
    const timer = window.setInterval(() => loadCases().catch(() => {}), 3500);
    return () => window.clearInterval(timer);
  }, []);

  async function assignCase(caseId) {
    const data = await api.request(`/api/therapist/cases/${caseId}/assign`, { method: "POST" });
    setCases((current) => current.map((item) => item.id === data.case.id ? data.case : item));
    setActiveCaseId(data.case.id);
  }

  async function sendCaseMessage(event) {
    event.preventDefault();
    if (!activeCase || !message.trim()) return;
    const data = await api.request(`/api/therapist/cases/${activeCase.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: message, status: "assigned" })
    });
    setCases((current) => current.map((item) => item.id === data.case.id ? data.case : item));
    setMessage("");
  }

  return (
    <main className="app-layout">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span>SV</span>
          <div>
            <strong>Safe Valve</strong>
            <small>{therapist.name}</small>
          </div>
        </div>
        <nav>
          <button className="active" type="button">Case queue</button>
        </nav>
        <button className="logout-button" type="button" onClick={onLogout}>Logout</button>
      </aside>
      <section className="content">
        <header className="topbar">
          <div>
            <p className="eyebrow">Professional support dashboard</p>
            <h1>Safe Valve Cases</h1>
          </div>
          <div className="session-badge">
            <span>Logged in</span>
            <strong>{therapist.username}</strong>
          </div>
        </header>
        {error && <p className="error-text">{error}</p>}
        <section className="therapist-layout">
          <article className="panel">
            <div className="panel-heading">
              <h2>Open and assigned cases</h2>
              <p>{cases.length} case{cases.length === 1 ? "" : "s"} visible to this account</p>
            </div>
            <div className="request-list">
              {cases.map((item) => (
                <button className={`request-item ${activeCase?.id === item.id ? "active" : ""}`} type="button" key={item.id} onClick={() => setActiveCaseId(item.id)}>
                  <strong>{item.reason}</strong>
                  <span>{item.status} - {item.urgency}</span>
                  <p>{item.alias} / {item.anonymousId}</p>
                </button>
              ))}
              {!cases.length && <p className="empty-text">No Safe Valve cases yet.</p>}
            </div>
          </article>
          <article className="panel case-chat-panel">
            {activeCase ? (
              <>
                <div className="panel-heading">
                  <h2>{activeCase.reason}</h2>
                  <p>{activeCase.assignedTherapistName ? `Assigned to ${activeCase.assignedTherapistName}` : "Unassigned case"}</p>
                </div>
                {!activeCase.assignedTherapistId && (
                  <button className="secondary-button assign-button" type="button" onClick={() => assignCase(activeCase.id)}>Accept case</button>
                )}
                <div className="case-message-list">
                  {(activeCase.messages || []).map((item) => (
                    <div className={`case-message ${item.senderType}`} key={item.id}>
                      <strong>{item.senderName}</strong>
                      <p>{item.content}</p>
                    </div>
                  ))}
                </div>
                <form className="composer case-composer" onSubmit={sendCaseMessage}>
                  <input value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Reply privately to the student..." />
                  <button className="primary-button" type="submit">Send</button>
                </form>
              </>
            ) : (
              <p className="empty-text">Select a case to view the private support conversation.</p>
            )}
          </article>
        </section>
      </section>
    </main>
  );
}

function PrivacyView({ user, group }) {
  return (
    <section className="privacy-grid">
      <Metric title="Anonymous ID" value={user.anonymousId} />
      <Metric title="Stored name" value="None" />
      <Metric title="Active group" value={group ? group.name : "None"} />
      <article className="panel privacy-panel">
        <div className="panel-heading">
          <h2>Prototype security model</h2>
          <p>This local build demonstrates the privacy workflow and routing logic.</p>
        </div>
       <ul>
        <li>No real names or student IDs are required to access peer support.</li>
        <li>Users are identified using anonymous session identifiers.</li>
        <li>Messages are encrypted and stored securely in the backend database.</li>
        <li>Vent Groups automatically expire after inactivity to protect privacy.</li>
        <li>Only authorized therapists can access escalated Safe Valve cases.</li>
        <li>Users must consent to privacy terms before entering the platform.</li>
        <li>Echovase does not publicly expose conversations or participant identities.</li>
      </ul>
      </article>
    </section>
  );
}

function Metric({ title, value }) {
  return (
    <article className="metric">
      <span>{title}</span>
      <strong>{value}</strong>
    </article>
  );
}

createRoot(document.getElementById("root")).render(<App />);
