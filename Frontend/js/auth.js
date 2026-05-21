// PatentAI — Auth Helper
const auth = {
  KEY: 'patentai_user',

  getUser() {
    try { return JSON.parse(localStorage.getItem(this.KEY)); } catch { return null; }
  },
  setUser(user) {
    localStorage.setItem(this.KEY, JSON.stringify(user));
  },
  clearUser() {
    localStorage.removeItem(this.KEY);
  },
  isLoggedIn() {
    return !!this.getUser();
  },
  requireAuth() {
    if (!this.isLoggedIn()) {
      window.location.href = '/login.html';
      return false;
    }
    return true;
  },
  requireGuest() {
    if (this.isLoggedIn()) {
      window.location.href = '/dashboard.html';
      return false;
    }
    return true;
  },
};

// Toast notifications
const toast = {
  container: null,
  init() {
    if (!this.container) {
      this.container = document.createElement('div');
      this.container.id = 'toast-container';
      document.body.appendChild(this.container);
    }
  },
  show(msg, type = 'info', duration = 3500) {
    this.init();
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = msg;
    this.container.appendChild(el);
    setTimeout(() => el.remove(), duration);
  },
  success(msg) { this.show(msg, 'success'); },
  error(msg) { this.show(msg, 'error'); },
  info(msg) { this.show(msg, 'info'); },
};

// Sidebar user info & active nav
function initSidebar() {
  const user = auth.getUser();
  if (!user) return;

  const nameEl = document.getElementById('user-name');
  const roleEl = document.getElementById('user-role');
  const avatarEl = document.getElementById('user-avatar');
  if (nameEl) nameEl.textContent = user.username;
  if (roleEl) roleEl.textContent = user.role;
  if (avatarEl) avatarEl.textContent = user.username[0].toUpperCase();

  // Active nav item
  const path = window.location.pathname;
  document.querySelectorAll('.nav-item[data-href]').forEach(item => {
    if (path.includes(item.dataset.href)) item.classList.add('active');
    item.addEventListener('click', () => window.location.href = item.dataset.href);
  });

  // Logout
  const logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      await api.users.logout().catch(() => {});
      auth.clearUser();
      window.location.href = '/index.html';
    });
  }
}

// Status badge helper
function statusBadge(status) {
  const map = {
    'Submitted': 'badge-submitted',
    'Under AI Review': 'badge-ai-review',
    'Formality Check Pending': 'badge-formality',
    'Requires Modification': 'badge-modification',
    'Examiner Review': 'badge-examiner',
    'Approved': 'badge-approved',
    'Rejected': 'badge-rejected',
    'Active': 'badge-active',
  };
  return `<span class="badge ${map[status] || 'badge-submitted'}">${status}</span>`;
}

function formatDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function scoreClass(n) {
  if (n >= 75) return 'high';
  if (n >= 50) return 'medium';
  return 'low';
}

function scoreBar(label, value) {
  if (value == null) return '';
  const cls = scoreClass(value);
  return `
    <div class="score-bar">
      <div class="score-label"><span>${label}</span><span>${value.toFixed(1)}</span></div>
      <div class="score-track"><div class="score-fill ${cls}" style="width:${value}%"></div></div>
    </div>`;
}
