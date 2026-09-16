import { connectHost, type GuestSessionsSnapshot, type GuestSessionWorktree } from '@openchamber/sdk';
import { applyHostReady, mountBanner, mountButton, mountList, mountSelect, mountText, mountTextField } from '@openchamber/sdk/ui';
import { TASKS, attachPayload } from './tasks';

const host = connectHost();
const root = document.querySelector('#root');
if (!root) throw new Error('Missing root');
let mounted = false;
const cleanup: Array<() => void> = [];
host.onReady((context) => {
  applyHostReady(context, document.documentElement);
  if (mounted) return;
  mounted = true;
  const controls = document.createElement('section');
  const activity = document.createElement('section');
  root.append(controls, activity);
  const notice = mountBanner(controls, { tone: 'info', title: 'Tasks board', body: 'Choose a project and a task. Starting a session keeps this board open.' });
  let projectId = '';
  let taskId = TASKS[0].id;
  let destination = 'root';
  let branchName = '';
  let baseBranch = '';
  let note = '';
  let noteEdited = false;
  let generation = 0;
  let stopSessions = () => {};
  let stopWorktrees = () => {};
  const report = async (operation: () => Promise<void>) => {
    try { await operation(); }
    catch (error) { notice.update({ tone: 'error', title: 'Could not finish', body: error instanceof Error ? error.message : String(error) }); }
  };
  const sessions = mountList(activity, { items: [], onSelect: (id) => { void report(() => host.openSession(id)); } });
  mountText(activity, { text: 'Select a session to open its chat. Idle means the agent stopped, not that the task is done.' });
  const updateSessions = (snapshot: GuestSessionsSnapshot) => {
    sessions.update({ items: snapshot.sessions.map((session) => ({ id: session.id, title: session.title,
      subtitle: `${session.activity}${session.outcome ? ` · ${session.outcome}` : ''} · ${session.worktree?.branch ?? 'project root'}` })) });
    notice.update({ tone: snapshot.state === 'error' ? 'error' : 'info', title: `Sessions: ${snapshot.state}`,
      body: snapshot.state === 'ready' ? 'Session states update live. Task completion is your choice.' : 'Retaining available data while the host loads or recovers this project.' });
  };
  const projectControl = document.createElement('div');
  controls.append(projectControl);
  const worktree = mountSelect(controls, { label: 'Session directory', value: destination,
    options: [{ id: 'root', label: 'Project root' }, { id: 'new', label: 'New worktree' }], onChange: (value) => { destination = value; worktree.update({ value }); } });
  const selectProject = async (id: string) => {
    projectId = id;
    projects.update({ value: id });
    destination = 'root';
    worktree.update({ value: 'root' });
    stopSessions(); stopWorktrees();
    const current = ++generation;
    const releaseSessions = await host.onSessions(id, (snapshot) => { if (current === generation) updateSessions(snapshot); });
    if (current !== generation) { releaseSessions(); return; }
    stopSessions = releaseSessions;
    try {
      const releaseWorktrees = await host.onWorktrees(id, (snapshot) => {
        if (current !== generation) return;
        worktree.update({ options: [{ id: 'root', label: 'Project root' }, { id: 'new', label: 'New worktree' },
          ...snapshot.worktrees.map((entry) => ({ id: entry.directory, label: `${entry.name} · ${entry.status}` }))] });
      });
      if (current !== generation) { releaseSessions(); releaseWorktrees(); return; }
      stopWorktrees = releaseWorktrees;
    } catch (error) { releaseSessions(); throw error; }
  };
  const projects = mountSelect(projectControl, { label: 'Project', value: '', options: [], onChange: (id) => { void report(() => selectProject(id)); } });
  const taskChoice = mountSelect(controls, { label: 'Task', value: taskId, options: TASKS.map((task) => ({ id: task.id, label: task.title })), onChange: (value) => { taskId = value; taskChoice.update({ value }); } });
  const branchField = mountTextField(controls, { label: 'New worktree name and branch', value: '', onChange: (value) => { branchName = value; branchField.update({ value }); } });
  const baseField = mountTextField(controls, { label: 'Base branch or ref', value: '', onChange: (value) => { baseBranch = value; baseField.update({ value }); } });
  const start = mountButton(controls, { label: 'Start session', onClick: () => {
    void report(async () => {
      const task = TASKS.find((entry) => entry.id === taskId);
      if (!task || !projectId) throw new Error('Choose a project and task first.');
      let target: GuestSessionWorktree = false;
      if (destination === 'new') {
        target = { kind: 'new' };
        if (branchName.trim()) target.name = branchName.trim();
        if (baseBranch.trim()) target.baseBranch = baseBranch.trim();
      } else if (destination !== 'root') target = { kind: 'existing', directory: destination };
      start.update({ loading: true });
      try {
        const result = await host.startSession({ ...attachPayload(task), projectId, worktree: target });
        notice.update({ tone: result.sessionId ? 'info' : 'error', title: result.sessionId ? 'Session created' : 'Worktree retained', body: JSON.stringify(result) });
      } finally { start.update({ loading: false }); }
    });
  } });
  const notes = mountTextField(activity, { label: 'Board notes', value: '', multiline: true, onChange: (value) => { noteEdited = true; note = value; notes.update({ value }); } });
  mountButton(activity, { label: 'Save notes', variant: 'outline', onClick: () => { void report(async () => {
    await host.storage.set('board-notes', note);
    notice.update({ tone: 'success', title: 'Notes saved', body: 'Stored with this extension on the connected server.' });
  }); } });
  void report(async () => {
    const saved = await host.storage.get('board-notes');
    if (!noteEdited) { note = String(saved ?? ''); notes.update({ value: note }); }
    const stop = await host.onProjects((snapshot) => {
      projects.update({ options: snapshot.projects.map((project) => ({ id: project.id, label: project.name })) });
      if (!snapshot.projects.some((entry) => entry.id === projectId)) {
        const first = snapshot.projects[0];
        if (first) { projects.update({ value: first.id }); void report(() => selectProject(first.id)); }
        else { projectId = ''; generation++; stopSessions(); stopWorktrees(); sessions.update({ items: [] }); }
      }
    });
    cleanup.push(stop);
  });
  cleanup.push(() => { generation++; stopSessions(); stopWorktrees(); });
});
window.addEventListener('pagehide', () => { for (const dispose of cleanup) dispose(); host.dispose(); });
