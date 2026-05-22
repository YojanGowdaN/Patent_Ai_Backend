// PatentAI — localStorage-based data layer + Groq AI backend calls
// No database required. All data lives in the browser.

const KEYS = {
  USERS:      'patentai_users',
  PATENTS:    'patentai_patents',
  ACTIVITY:   'patentai_activity',
  TRADEMARKS: 'patentai_trademarks',
};

// ── Storage helpers ──────────────────────────────────────────────────────────
const store = {
  get(key)      { try { return JSON.parse(localStorage.getItem(key)) || []; } catch { return []; } },
  set(key, val) { localStorage.setItem(key, JSON.stringify(val)); },
};

function nextId(items) {
  return items.length ? Math.max(...items.map(i => i.id || 0)) + 1 : 1;
}

function generatePatentId() {
  return `PAT-${new Date().getFullYear()}-${Math.floor(Math.random() * 9000) + 1000}`;
}

function simpleHash(str) {
  // Simple deterministic hash for password storage in localStorage (demo use)
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return 'h' + Math.abs(h).toString(16);
}

function logActivity(patentId, patentTitle, action) {
  const activity = store.get(KEYS.ACTIVITY);
  activity.unshift({
    id: nextId(activity),
    patent_id: patentId,
    patent_title: patentTitle,
    action,
    created_at: new Date().toISOString(),
  });
  store.set(KEYS.ACTIVITY, activity.slice(0, 300));
}

// ── Seed demo account on first load ─────────────────────────────────────────
(function seedDemo() {
  const users = store.get(KEYS.USERS);
  if (!users.find(u => u.email === 'examiner@patentai.gov')) {
    users.push({
      id: 1,
      username: 'Chief Examiner',
      email: 'examiner@patentai.gov',
      password_hash: simpleHash('examiner123patentai_salt_2024'),
      role: 'examiner',
      created_at: new Date().toISOString(),
    });
    store.set(KEYS.USERS, users);
  }
})();

// ── AI backend caller ────────────────────────────────────────────────────────
async function callAI(endpoint, body) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 90000);
  try {
    const res = await fetch('/api/ai/' + endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!res.ok) {
      const e = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(e.error || `AI call failed (${res.status})`);
    }
    return res.json();
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') throw new Error('AI request timed out. Please try again.');
    throw err;
  }
}

// ── Similarity helper — checks word overlap between two text strings ─────────
function isSimilarText(text1, text2) {
  const words1 = new Set((text1 || '').toLowerCase().match(/\b\w{4,}\b/g) || []);
  const words2 = new Set((text2 || '').toLowerCase().match(/\b\w{4,}\b/g) || []);
  if (!words1.size || !words2.size) return false;
  let overlap = 0;
  for (const w of words1) { if (words2.has(w)) overlap++; }
  return (overlap / Math.min(words1.size, words2.size)) > 0.4;
}

// ── Main API object ──────────────────────────────────────────────────────────
const api = {

  // ── Patents ────────────────────────────────────────────────────────────────
  patents: {
    list(params = {}) {
      let patents = store.get(KEYS.PATENTS);
      const { status, domain, search } = params;
      if (status) patents = patents.filter(p => p.status === status);
      if (domain) patents = patents.filter(p => p.technical_domain === domain);
      if (search) {
        const s = search.toLowerCase();
        patents = patents.filter(p =>
          (p.title || '').toLowerCase().includes(s) ||
          (p.description || '').toLowerCase().includes(s) ||
          (p.patent_id || '').toLowerCase().includes(s)
        );
      }
      return Promise.resolve(patents.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)));
    },

    get(id) {
      const p = store.get(KEYS.PATENTS).find(p => String(p.id) === String(id));
      if (!p) return Promise.reject(new Error('Patent not found'));
      return Promise.resolve(p);
    },

    create(data) {
      const patents = store.get(KEYS.PATENTS);
      const now = new Date().toISOString();
      const patent = {
        id: nextId(patents),
        patent_id: generatePatentId(),
        applicant_name:  data.applicant_name,
        inventor_name:   data.inventor_name || data.applicant_name,
        title:           data.title,
        description:     data.description,
        technical_domain: data.technical_domain,
        claims:          data.claims || null,
        status:          'Submitted',
        novelty_score:         null,
        patent_strength_score: null,
        formality_score:       null,
        ai_report:             null,
        similarity_risk:       false,
        filing_date: now,
        created_at:  now,
        updated_at:  now,
      };
      patents.push(patent);
      store.set(KEYS.PATENTS, patents);
      logActivity(patent.patent_id, patent.title, 'Patent submitted');
      return Promise.resolve(patent);
    },

    withdraw(id) {
      const patents = store.get(KEYS.PATENTS);
      const patent  = patents.find(p => String(p.id) === String(id));
      if (!patent) return Promise.reject(new Error('Patent not found'));
      store.set(KEYS.PATENTS, patents.filter(p => String(p.id) !== String(id)));
      const activity = store.get(KEYS.ACTIVITY).filter(a => a.patent_id !== patent.patent_id);
      store.set(KEYS.ACTIVITY, activity);
      return Promise.resolve({ deleted: true });
    },

    update(id, data) {
      const patents = store.get(KEYS.PATENTS);
      const idx = patents.findIndex(p => String(p.id) === String(id));
      if (idx === -1) return Promise.reject(new Error('Patent not found'));
      patents[idx] = { ...patents[idx], ...data, updated_at: new Date().toISOString() };
      store.set(KEYS.PATENTS, patents);
      if (data.status) logActivity(patents[idx].patent_id, patents[idx].title, `Status → ${data.status}`);
      return Promise.resolve(patents[idx]);
    },

    async analyze(id) {
      const patents = store.get(KEYS.PATENTS);
      const idx = patents.findIndex(p => String(p.id) === String(id));
      if (idx === -1) throw new Error('Patent not found');

      // Mark as under review immediately
      patents[idx].status = 'Under AI Review';
      patents[idx].updated_at = new Date().toISOString();
      store.set(KEYS.PATENTS, patents);
      logActivity(patents[idx].patent_id, patents[idx].title, 'AI analysis started');

      // Fetch existing patents for duplicate detection
      const existing = store.get(KEYS.PATENTS).filter(p =>
        String(p.id) !== String(id) &&
        !['Rejected', 'Requires Modification'].includes(p.status)
      );

      try {
        const analysis = await callAI('analyze', { patent: patents[idx], existingPatents: existing });

        const fresh = store.get(KEYS.PATENTS);
        const fi = fresh.findIndex(p => String(p.id) === String(id));
        const isDuplicate = analysis.isDuplicate === true;
        const aiRejects = isDuplicate || analysis.decisionRecommendation === 'REJECT';
        const similarityRisk = isDuplicate || (analysis.similarPatents || []).some(s => s.similarityScore >= 65);

        if (aiRejects) {
          fresh[fi] = {
            ...fresh[fi],
            novelty_score:         analysis.noveltyScore,
            patent_strength_score: analysis.strengthScore,
            ai_report:             analysis,
            similarity_risk:       true,
            status:                'Rejected',
            updated_at:            new Date().toISOString(),
          };
          store.set(KEYS.PATENTS, fresh);
          logActivity(fresh[fi].patent_id, fresh[fi].title,
            `AI: REJECTED — ${isDuplicate ? `duplicate of ${analysis.duplicateOf}. ${analysis.duplicateReason}` : analysis.decisionReason}`
          );
          return { patent_id: id, status: 'Rejected', ...analysis };
        }

        // AI approves → save scores, move to formality check
        fresh[fi] = {
          ...fresh[fi],
          novelty_score:         analysis.noveltyScore,
          patent_strength_score: analysis.strengthScore,
          ai_report:             analysis,
          similarity_risk:       similarityRisk,
          status:                'Formality Check Pending',
          updated_at:            new Date().toISOString(),
        };
        store.set(KEYS.PATENTS, fresh);
        logActivity(fresh[fi].patent_id, fresh[fi].title,
          `AI analysis complete — novelty: ${analysis.noveltyScore}, strength: ${analysis.strengthScore}`
        );

        // ── Step 2: Auto-run formality check ─────────────────────────────────
        let finalStatus = 'Formality Check Pending';
        try {
          logActivity(fresh[fi].patent_id, fresh[fi].title, 'Formality check started (automatic)');
          const formalityResult = await callAI('formality-check', { patent: fresh[fi] });

          const latest = store.get(KEYS.PATENTS);
          const li = latest.findIndex(p => String(p.id) === String(id));

          if (!formalityResult.passed) {
            latest[li] = {
              ...latest[li],
              formality_score: formalityResult.score,
              status:          'Requires Modification',
              updated_at:      new Date().toISOString(),
            };
            store.set(KEYS.PATENTS, latest);
            logActivity(latest[li].patent_id, latest[li].title,
              `Formality check FAILED (score: ${formalityResult.score}) — ${formalityResult.summary}`
            );
            return { patent_id: id, status: 'Requires Modification', ...analysis };
          }

          // ── Step 3: Auto-decide based on localStorage similarity ──────────
          // Check if any APPROVED patent in localStorage is similar to this one
          const allPatents = store.get(KEYS.PATENTS);
          const thisPat = allPatents.find(p => String(p.id) === String(id));
          const hasSimilarInStore = allPatents.some(p =>
            String(p.id) !== String(id) &&
            p.status === 'Approved' &&
            p.technical_domain === thisPat.technical_domain &&
            isSimilarText(
              (p.title || '') + ' ' + (p.description || ''),
              (thisPat.title || '') + ' ' + (thisPat.description || '')
            )
          );

          // Also respect the AI similarity risk flag
          const hasSimilarityRisk = latest[li].similarity_risk;

          finalStatus = (hasSimilarInStore || hasSimilarityRisk) ? 'Rejected' : 'Approved';

          latest[li] = {
            ...latest[li],
            formality_score: formalityResult.score,
            status:          finalStatus,
            updated_at:      new Date().toISOString(),
          };
          store.set(KEYS.PATENTS, latest);

          const reason = hasSimilarInStore
            ? 'similar approved patent already exists in records'
            : hasSimilarityRisk
            ? 'AI detected similarity risk with existing patents'
            : 'no similar patents found';
          logActivity(latest[li].patent_id, latest[li].title,
            `Formality check PASSED (score: ${formalityResult.score}). Auto-decision: ${finalStatus} — ${reason}`
          );
        } catch (formalityErr) {
          logActivity(fresh[fi].patent_id, fresh[fi].title,
            `Formality check error: ${formalityErr.message}`
          );
        }

        return { patent_id: id, status: finalStatus, ...analysis };

      } catch (err) {
        const fresh = store.get(KEYS.PATENTS);
        const fi = fresh.findIndex(p => String(p.id) === String(id));
        if (fi !== -1) {
          fresh[fi].status = 'Submitted';
          fresh[fi].updated_at = new Date().toISOString();
          store.set(KEYS.PATENTS, fresh);
          logActivity(fresh[fi].patent_id, fresh[fi].title, `AI analysis failed: ${err.message}`);
        }
        throw err;
      }
    },

    async formalityCheck(id) {
      const patent = store.get(KEYS.PATENTS).find(p => String(p.id) === String(id));
      if (!patent) throw new Error('Patent not found');

      const result = await callAI('formality-check', { patent });

      const newStatus = result.passed ? 'Examiner Review' : 'Requires Modification';
      const patents = store.get(KEYS.PATENTS);
      const idx = patents.findIndex(p => String(p.id) === String(id));
      patents[idx] = { ...patents[idx], formality_score: result.score, status: newStatus, updated_at: new Date().toISOString() };
      store.set(KEYS.PATENTS, patents);
      logActivity(patents[idx].patent_id, patents[idx].title,
        `Formality check ${result.passed ? 'PASSED' : 'FAILED'} (score: ${result.score}) — ${result.summary}`
      );

      return { patent_id: id, status: newStatus, ...result };
    },

    async similarity(id) {
      const patents = store.get(KEYS.PATENTS);
      const patent = patents.find(p => String(p.id) === String(id));
      if (!patent) throw new Error('Patent not found');

      const existing = patents.filter(p =>
        String(p.id) !== String(id) &&
        p.technical_domain === patent.technical_domain
      );
      if (!existing.length) return [];

      return callAI('similarity', { patent, existingPatents: existing });
    },
  },

  // ── Trademarks ─────────────────────────────────────────────────────────────
  trademarks: {
    list(params = {}) {
      let tms = store.get(KEYS.TRADEMARKS);
      if (params.search) {
        const s = params.search.toLowerCase();
        tms = tms.filter(t =>
          (t.trademark_name || '').toLowerCase().includes(s) ||
          (t.owner || '').toLowerCase().includes(s)
        );
      }
      return Promise.resolve(tms.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)));
    },

    create(data) {
      const tms = store.get(KEYS.TRADEMARKS);
      const tm = {
        id: nextId(tms),
        trademark_name: data.trademark_name,
        owner:    data.owner,
        category: data.category,
        goods_services_class: data.goods_services_class || null,
        status: 'Active',
        created_at: new Date().toISOString(),
      };
      tms.push(tm);
      store.set(KEYS.TRADEMARKS, tms);
      return Promise.resolve(tm);
    },

    async check(data) {
      const existing = store.get(KEYS.TRADEMARKS);
      return callAI('trademark-check', {
        trademark_name: data.trademark_name,
        brand_text: data.brand_text,
        existingTrademarks: existing,
      });
    },
  },

  // ── Dashboard (computed from localStorage) ─────────────────────────────────
  dashboard: {
    stats() {
      const patents = store.get(KEYS.PATENTS);
      const today   = new Date(); today.setHours(0, 0, 0, 0);
      const weekAgo = new Date(today); weekAgo.setDate(weekAgo.getDate() - 7);
      const ns = patents.filter(p => p.novelty_score != null).map(p => p.novelty_score);
      const ss = patents.filter(p => p.patent_strength_score != null).map(p => p.patent_strength_score);
      const avg = arr => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length * 10) / 10 : null;
      return Promise.resolve({
        total_patents:       patents.length,
        approved:            patents.filter(p => p.status === 'Approved').length,
        rejected:            patents.filter(p => p.status === 'Rejected').length,
        ai_reviewed:         patents.filter(p => ['Formality Check Pending','Examiner Review','Approved','Rejected'].includes(p.status)).length,
        pending_review:      patents.filter(p => ['Submitted','Under AI Review','Formality Check Pending','Requires Modification','Examiner Review'].includes(p.status)).length,
        duplicate_risk:      patents.filter(p => p.similarity_risk).length,
        today_submissions:   patents.filter(p => new Date(p.created_at) >= today).length,
        weekly_submissions:  patents.filter(p => new Date(p.created_at) >= weekAgo).length,
        avg_novelty_score:   avg(ns),
        avg_strength_score:  avg(ss),
      });
    },

    recentActivity() {
      const activity = store.get(KEYS.ACTIVITY)
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .slice(0, 20);
      return Promise.resolve(activity);
    },

    domainBreakdown() {
      const counts = {};
      store.get(KEYS.PATENTS).forEach(p => {
        counts[p.technical_domain] = (counts[p.technical_domain] || 0) + 1;
      });
      return Promise.resolve(
        Object.entries(counts).map(([domain, count]) => ({ domain, count }))
          .sort((a, b) => b.count - a.count)
      );
    },

    statusBreakdown() {
      const counts = {};
      store.get(KEYS.PATENTS).forEach(p => {
        counts[p.status] = (counts[p.status] || 0) + 1;
      });
      return Promise.resolve(
        Object.entries(counts).map(([status, count]) => ({ status, count }))
          .sort((a, b) => b.count - a.count)
      );
    },
  },

  // ── Users (localStorage — no server round-trip) ────────────────────────────
  users: {
    register(data) {
      const users = store.get(KEYS.USERS);
      if (users.find(u => u.email === data.email)) {
        return Promise.reject(new Error('Email already registered'));
      }
      const user = {
        id: nextId(users),
        username:      data.username,
        email:         data.email,
        password_hash: simpleHash(data.password + 'patentai_salt_2024'),
        role:          data.role || 'applicant',
        created_at:    new Date().toISOString(),
      };
      users.push(user);
      store.set(KEYS.USERS, users);
      return Promise.resolve({ id: user.id, username: user.username, email: user.email, role: user.role });
    },

    login(data) {
      const users = store.get(KEYS.USERS);
      const user  = users.find(u => u.email === data.email);
      if (!user || user.password_hash !== simpleHash(data.password + 'patentai_salt_2024')) {
        return Promise.reject(new Error('Invalid email or password'));
      }
      return Promise.resolve({ id: user.id, username: user.username, email: user.email, role: user.role });
    },

    me() {
      const user = auth.getUser();
      return user ? Promise.resolve(user) : Promise.reject(new Error('Not authenticated'));
    },

    logout() {
      return Promise.resolve({ message: 'Logged out' });
    },
  },
};
