import { useEffect, useState } from 'react'
import './App.css'

type Candidate = { jid: string; name: string; count: number; lastReason: string; kind: 'direct'|'group'; lastSeen: string };

function App() {
  const [status, setStatus] = useState<any>(null);
  const [config, setConfig] = useState<any>(null);
  const [unauthorized, setUnauthorized] = useState<Candidate[]>([]);
  const [groups, setGroups] = useState<{jid: string, name: string}[]>([]);
  const [chats, setChats] = useState<Record<string, any[]>>({});
  const [activeTab, setActiveTab] = useState('status');
  const [selectedChatJid, setSelectedChatJid] = useState<string|null>(null);
  const [persona, setPersona] = useState<any>(null);
  const [editingPersona, setEditingPersona] = useState<{soul:string; communicationRules:string; recentMemory:string}>({soul:'',communicationRules:'',recentMemory:''});

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 3000);
    return () => clearInterval(interval);
  }, []);

  const fetchData = async () => {
    try {
      const [st, cfg, unauth, grp, per, ch] = await Promise.all([
        fetch('/api/status').then(res => res.json()),
        fetch('/api/config').then(res => res.json()),
        fetch('/api/unauthorized').then(res => res.json()),
        fetch('/api/groups').then(res => res.json()),
        fetch('/api/persona').then(res => res.json()),
        fetch('/api/chats').then(res => res.json())
      ]);
      setStatus(st);
      setConfig(cfg);
      setUnauthorized(unauth);
      setGroups(grp);
      setChats(ch || {});
      if (!persona) {
        setPersona(per);
        setEditingPersona(per);
      }
    } catch(err) {
      console.error('Fetch error:', err);
    }
  };

  const handleResolve = async (jid: string, action: 'allow'|'discard', listType: 'direct'|'group') => {
    await fetch('/api/unauthorized/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jid, action, listType })
    });
    fetchData();
  };

  const handleSavePersona = async () => {
    await fetch('/api/persona', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(editingPersona)
    });
    alert('Persona saved');
  };

  const executeSessionAction = async (action: 'relink'|'repair') => {
    await fetch(`/api/session/${action}`, { method: 'POST', headers:{'Content-Type':'application/json'} });
    alert(`Session ${action} initiated`);
  };

  if (!status) return <div>Loading UI...</div>;

  return (
    <div className="container">
      <header>
        <h1>Talky Web Console</h1>
        <div>Status: <span className="status-badge">{status.status}</span> on Port {status.port}</div>
      </header>
      
      <nav className="tabs">
        <button className={activeTab === 'status' ? 'active' : ''} onClick={() => setActiveTab('status')}>Dashboard</button>
        <button className={activeTab === 'chats' ? 'active' : ''} onClick={() => setActiveTab('chats')}>Ongoing Chats</button>
        <button className={activeTab === 'allowlists' ? 'active' : ''} onClick={() => setActiveTab('allowlists')}>Allowlists</button>
        <button className={activeTab === 'unauthorized' ? 'active' : ''} onClick={() => setActiveTab('unauthorized')}>Inbox ({unauthorized.length})</button>
        <button className={activeTab === 'persona' ? 'active' : ''} onClick={() => setActiveTab('persona')}>Persona Editor</button>
        <button className={activeTab === 'actions' ? 'active' : ''} onClick={() => setActiveTab('actions')}>Actions</button>
      </nav>

      <main>
        {activeTab === 'status' && (
          <section>
            <h2>Runtime Config</h2>
            <pre className="code-block">{JSON.stringify(config, null, 2)}</pre>
          </section>
        )}

        {activeTab === 'chats' && (
          <section>
          <h2>Ongoing Direct Chats</h2>
          <div className="chats-container" style={{ display: 'flex', gap: '20px' }}>
            <div className="chat-sidebar" style={{ width: '30%', borderRight: '1px solid #ccc', paddingRight: '10px' }}>
              <h3>Recent Conversations</h3>
              <ul className="chat-list" style={{ listStyleType: 'none', padding: 0 }}>
                {Object.keys(chats).length === 0 ? <p>No chats found</p> : Object.keys(chats).map(jid => (
                  <li key={jid} className={`chat-list-item ${selectedChatJid === jid ? 'active' : ''}`} style={{ padding: '8px', cursor: 'pointer', backgroundColor: selectedChatJid === jid ? '#eee' : 'transparent' }} onClick={() => setSelectedChatJid(jid)}>
                     {jid} <span className="badge">({chats[jid].length})</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="chat-main" style={{ width: '70%', paddingLeft: '10px' }}>
              {!selectedChatJid && <p>Select a chat from the sidebar to view messages.</p>}
              {selectedChatJid && chats[selectedChatJid] && (
                <div className="chat-window">
                  <h3>Chat: {selectedChatJid}</h3>
                  <div className="messages" style={{maxHeight:'600px', overflowY:'auto', display: 'flex', flexDirection: 'column', gap: '10px', padding: '10px', border: '1px solid #eee', borderRadius: '5px' }}>
                    {chats[selectedChatJid].map((msg: any, i: number) => (
                      <div key={i} className={`message ${msg.role === 'outgoing' ? 'sent' : 'received'}`} style={{ alignSelf: msg.role === 'outgoing' ? 'flex-end' : 'flex-start', maxWidth: '70%', padding: '10px', borderRadius: '10px', backgroundColor: msg.role === 'outgoing' ? '#dcf8c6' : '#fff', border: '1px solid #ddd' }}>
                        <div className="message-meta" style={{ fontSize: '0.8rem', color: '#666', marginBottom: '5px' }}>
                           <strong>{msg.role === 'outgoing' ? 'Talky' : msg.senderJid?.split('@')[0] || 'Unknown'}</strong> 
                           <span> - {new Date(msg.timestampISO).toLocaleTimeString()}</span>
                        </div>
                        <div className="message-bubble" style={{ whiteSpace: 'pre-wrap' }}>{msg.text}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
            </div>
          </section>
        )}

        {activeTab === 'allowlists' && config && (
          <section>
            <div className="grid">
              <div>
                <h2>Allowed Direct JIDs</h2>
                <ul>
                  {config.allowedDirectJids.length === 0 ? <li>(None)</li> : config.allowedDirectJids.map((jid:string) => (
                    <li key={jid}>{jid}</li>
                  ))}
                </ul>
              </div>
              <div>
                <h2>Allowed Groups</h2>
                <ul>
                  {config.allowedGroupJids.length === 0 ? <li>(None)</li> : config.allowedGroupJids.map((jid:string) => (
                    <li key={jid}>{jid}</li>
                  ))}
                </ul>
              </div>
            </div>
            <h3>Active Available Groups</h3>
            <ul className="groups-list">
              {groups.map(g => (
                <li key={g.jid} className="groups-list-item">
                  <strong>{g.name}</strong> <br/><small>{g.jid}</small>
                </li>
              ))}
            </ul>
          </section>
        )}

        {activeTab === 'unauthorized' && (
           <section>
             <h2>Unauthorized Inbox</h2>
             {unauthorized.length === 0 ? <p>No unauthorized messages detected.</p> : (
               <table className="table">
                 <thead>
                   <tr>
                     <th>Sender</th>
                     <th>Kind</th>
                     <th>Count</th>
                     <th>Last Reason</th>
                     <th>Actions</th>
                   </tr>
                 </thead>
                 <tbody>
                   {unauthorized.map(u => (
                     <tr key={u.jid}>
                       <td><strong>{u.name || 'Unknown'}</strong><br/><small>{u.jid}</small></td>
                       <td>{u.kind}</td>
                       <td>{u.count}</td>
                       <td>{u.lastReason}</td>
                       <td>
                         <button onClick={() => handleResolve(u.jid, 'allow', u.kind)}>Allow</button>
                         <button onClick={() => handleResolve(u.jid, 'discard', u.kind)}>Dismiss</button>
                       </td>
                     </tr>
                   ))}
                 </tbody>
               </table>
             )}
           </section>
        )}

        {activeTab === 'persona' && editingPersona && (
           <section className="persona-editor">
             <h2>Persona Editor</h2>
             <div>
                <label>Soul (`soul.md`)</label><br/>
                <textarea rows={10} cols={80} value={editingPersona.soul} onChange={e => setEditingPersona({...editingPersona, soul: e.target.value})} />
             </div>
             <div>
                <label>Communication Rules (`communication_rules.md`)</label><br/>
                <textarea rows={10} cols={80} value={editingPersona.communicationRules} onChange={e => setEditingPersona({...editingPersona, communicationRules: e.target.value})} />
             </div>
             <div>
                <label>Recent Memory (`recent_memory.md`)</label><br/>
                <textarea rows={10} cols={80} value={editingPersona.recentMemory} onChange={e => setEditingPersona({...editingPersona, recentMemory: e.target.value})} />
             </div>
             <button onClick={handleSavePersona}>Save Text</button>
           </section>
        )}

        {activeTab === 'actions' && (
           <section className="actions-panel">
             <h2>System Actions</h2>
             <button onClick={() => executeSessionAction('relink')}>Relink Session</button>
             <button onClick={() => executeSessionAction('repair')}>Repair Session</button>
           </section>
        )}
      </main>
    </div>
  )
}

export default App
