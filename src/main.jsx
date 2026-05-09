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
        api.clearToken();
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

  function logout() {
    api.clearToken();
    setUser(null);
    setGroup(null);
    setSafeValve([]);
    setActiveView("vent");
    setNotice("");
  }

  if (loading) return <main className="loading-screen">Opening anonymous space...</main>;
  if (!user) return <EntryScreen onStart={startSession} error={error} setError={setError} />;

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
        {activeView === "safe" && <SafeValveView requests={safeValve} onCreate={createSafeValve} />}
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

function EntryScreen({ onStart, error, setError }) {
  const [alias, setAlias] = useState("");
  const [intensity, setIntensity] = useState("medium");

  async function submit(event) {
    event.preventDefault();
    setError("");
    try {
      await onStart({ alias, intensity });
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
      <form className="entry-panel form-stack" onSubmit={submit}>
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
        <button className="primary-button" type="submit">Start anonymously</button>
        {error && <p className="error-text">{error}</p>}
      </form>
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
        <Metric title="Session lifetime" value="90 min" />
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
    const minutes = Math.max(0, Math.round((new Date(group.expiresAt) - Date.now()) / 60000));
    return `${minutes} min`;
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

function SafeValveView({ requests, onCreate }) {
  const [reason, setReason] = useState("I need professional support");
  const [contactPreference, setContactPreference] = useState("in-app follow-up");
  const [details, setDetails] = useState("");

  async function submit(event) {
    event.preventDefault();
    await onCreate({ reason, contactPreference, details });
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
            <div className="request-item" key={request.id}>
              <strong>{request.reason}</strong>
              <span>{request.status}</span>
              <p>{request.details}</p>
            </div>
          ))}
          {!requests.length && <p className="empty-text">No Safe Valve requests yet.</p>}
        </div>
      </article>
    </section>
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
          <li>Students use anonymous aliases and token-based sessions.</li>
          <li>Vent Groups expire after a short session window.</li>
          <li>Messages are attached to anonymous identifiers, not real names.</li>
          <li>High-risk language opens a Safe Valve request for professional review.</li>
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
