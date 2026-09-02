const { useState, useEffect, useMemo, useCallback } = React;


// ---------------------------------------------------------------------------
// Connexion Airtable (via le proxy Vercel — jamais de token dans ce fichier)
// ---------------------------------------------------------------------------
const PROXY_URL = "https://planning-ateliers-proxy.vercel.app/api/airtable-proxy";

async function airtableRequest(table, { id, method = "GET", params, body } = {}) {
  const query = { table, ...(id ? { id } : {}), ...(params || {}) };
  const qs = new URLSearchParams(query).toString();
  const res = await fetch(`${PROXY_URL}?${qs}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = (data && data.error && (data.error.message || data.error)) || `Erreur Airtable (${res.status})`;
    throw new Error(typeof message === "string" ? message : JSON.stringify(message));
  }
  return data;
}

async function airtableGetAll(table, params) {
  let records = [];
  let offset;
  do {
    const data = await airtableRequest(table, { params: offset ? { ...params, offset } : params });
    records = records.concat(data.records || []);
    offset = data.offset;
  } while (offset);
  return records;
}

async function airtableCreateMany(table, fieldsArray) {
  // L'API Airtable accepte jusqu'à 10 enregistrements par appel — largement suffisant
  // ici (max 4, une série mensuelle).
  const body = { records: fieldsArray.map((fields) => ({ fields })) };
  const data = await airtableRequest(table, { method: "POST", body });
  return data.records;
}

async function airtableCreate(table, fields) {
  const [record] = await airtableCreateMany(table, [fields]);
  return record;
}

async function airtableUpdate(table, id, fields) {
  return airtableRequest(table, { id, method: "PATCH", body: { fields } });
}

async function airtableDelete(table, id) {
  return airtableRequest(table, { id, method: "DELETE" });
}

async function airtableDeleteMany(table, ids) {
  for (const id of ids) {
    await airtableDelete(table, id);
  }
}

// ---------------------------------------------------------------------------
// Constantes métier
// ---------------------------------------------------------------------------
const STORAGE_KEY = "data"; // ne sert plus qu'aux jours fermés / comptes / journal (pas encore dans Airtable)
const CAPACITY = 18;
const WEEKDAY_NAMES = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi"];
const MONTHS_FR = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
const RECURRENCE_OFFSETS = [0, 7, 14, 21]; // un abonnement mensuel = 4 semaines
const ACTIVITES = ["Études", "Fablab", "Codage"]; // activité prévue pour ce créneau précis
const GROUPES = ["Groupe 1", "Groupe 2", "Groupe 3", "Groupe 4"]; // purement informatif, aucune capacité par groupe
const STATUTS = ["À rappeler", "Rappelé", "Inscrit", "Sans suite"];
const STATUT_COLORS = {
  "à rappeler": { bg: "#F1EDE0", fg: "#8A6D1F" },
  "rappelé": { bg: "#E4EEF7", fg: "#2E5F8A" },
  "inscrit": { bg: "#E4EFE8", fg: "#3F6B52" },
  "sans suite": { bg: "#F1EDE5", fg: "#8A8371" },
};

const ZONE_C_2026_2027 = [
  { label: "Vacances de la Toussaint", start: "2026-10-17", end: "2026-11-01" },
  { label: "Armistice (11 novembre)", start: "2026-11-11", end: "2026-11-11" },
  { label: "Vacances de Noël", start: "2026-12-19", end: "2027-01-03" },
  { label: "Vacances d'hiver (zone C)", start: "2027-02-06", end: "2027-02-21" },
  { label: "Lundi de Pâques", start: "2027-03-29", end: "2027-03-29" },
  { label: "Vacances de printemps (zone C)", start: "2027-04-03", end: "2027-04-18" },
  { label: "Ascension (pont)", start: "2027-05-06", end: "2027-05-07" },
  { label: "Vacances d'été", start: "2027-07-03", end: "2027-08-31" },
];

function uid(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
function pad(n) {
  return n < 10 ? "0" + n : "" + n;
}
function isoDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function getMonday(d) {
  const date = new Date(d);
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diff);
  date.setHours(0, 0, 0, 0);
  return date;
}
function addDays(d, n) {
  const nd = new Date(d);
  nd.setDate(nd.getDate() + n);
  return nd;
}
function shortLabel(d) {
  return `${d.getDate()} ${MONTHS_FR[d.getMonth()]}`;
}
function weekdayNameForDate(iso) {
  const d = new Date(iso + "T00:00:00");
  return WEEKDAY_NAMES[d.getDay() - 1];
}
function weekDatesForIso(iso) {
  const monday = getMonday(new Date(iso + "T00:00:00"));
  return Array.from({ length: 6 }, (_, i) => isoDate(addDays(monday, i)));
}
function findClosedEntry(iso, closedPeriods) {
  return closedPeriods.find((cp) => iso >= cp.start && iso <= cp.end) || null;
}
function formatRange(start, end) {
  const s = new Date(start + "T00:00:00");
  const e = new Date(end + "T00:00:00");
  if (start === end) return shortLabel(s);
  return `${shortLabel(s)} → ${shortLabel(e)}`;
}

const emptyBookingDraft = (presetDate, presetCreneauId) => ({
  assignmentId: null,
  originalDate: null,
  originalCreneauId: null,
  seriesId: null,
  seriesFutureCount: 0,
  rosterId: null,
  query: "",
  date: presetDate || "",
  creneauId: presetCreneauId || null,
  activite: "",
  groupe: "",
  creatingNew: false,
  newPrenom: "",
  newNom: "",
  newPhone: "",
  newEmail: "",
});

const emptyRosterDraft = () => ({
  editingId: null,
  prenom: "",
  nom: "",
  phone: "",
  email: "",
  joursAbonnement: [],
  status: "À rappeler",
});

const REASON_LABELS = {
  ferme: (r) => `ignoré — fermé (${r})`,
  complet: () => "ignoré — créneau complet",
  quota: () => "ignoré — quota d'abonnement atteint cette semaine-là",
  doublon: () => "déjà inscrit(e) sur ce créneau",
};

function App() {
  const [loaded, setLoaded] = useState(false);
  const [apiError, setApiError] = useState("");

  const [creneauxByDay, setCreneauxByDay] = useState({});
  const [roster, setRoster] = useState([]);
  const [assignments, setAssignments] = useState([]);

  const [closedPeriods, setClosedPeriods] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [activityLog, setActivityLog] = useState([]);
  const [currentAccountId, setCurrentAccountId] = useState(null);

  const [monday, setMonday] = useState(getMonday(new Date()));
  const [view, setView] = useState("planning"); // planning | roster | closed | accounts
  const [search, setSearch] = useState("");
  const [rosterFilter, setRosterFilter] = useState("tous");
  const [rosterSearch, setRosterSearch] = useState("");

  const [booking, setBooking] = useState(null);
  const [bookingError, setBookingError] = useState("");
  const [bookingSummary, setBookingSummary] = useState(null);
  const [deletePanelOpen, setDeletePanelOpen] = useState(false);

  const [rosterModal, setRosterModal] = useState(null);
  const [rosterError, setRosterError] = useState("");

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [creneauError, setCreneauError] = useState({});

  const [closedForm, setClosedForm] = useState({ label: "", start: "", end: "" });
  const [closedError, setClosedError] = useState("");

  const [accountModal, setAccountModal] = useState(null);
  const [accountError, setAccountError] = useState("");

  const [confirmDeleteRoster, setConfirmDeleteRoster] = useState(null);
  const [confirmDeleteClosed, setConfirmDeleteClosed] = useState(null);
  const [confirmDeleteAccount, setConfirmDeleteAccount] = useState(null);

  const weekDates = useMemo(() => Array.from({ length: 6 }, (_, i) => addDays(monday, i)), [monday]);
  const weekIsoSet = useMemo(() => new Set(weekDates.map(isoDate)), [weekDates]);

  // --- chargement / rafraîchissement depuis Airtable ---
  const refreshCreneaux = useCallback(async () => {
    const records = await airtableGetAll("creneaux");
    const byDay = {};
    WEEKDAY_NAMES.forEach((d) => (byDay[d] = []));
    records.forEach((rec) => {
      const day = rec.fields["Jour"];
      if (!byDay[day]) return;
      byDay[day].push({ id: rec.id, horaire: rec.fields["Horaire"] || "" });
    });
    Object.keys(byDay).forEach((d) => byDay[d].sort((a, b) => a.horaire.localeCompare(b.horaire)));
    setCreneauxByDay(byDay);
  }, []);

  const refreshRoster = useCallback(async () => {
    const records = await airtableGetAll("eleves");
    setRoster(
      records.map((rec) => {
        const f = rec.fields;
        const joursAbonnement = WEEKDAY_NAMES.filter(
          (d) => String(f[`eleve-jour-${d.toLowerCase()}`]).toLowerCase() === "true"
        );
        const prenom = f["eleve-prenom"] || "";
        const nom = f["eleve-nom"] || "";
        return {
          id: rec.id,
          prenom,
          nom,
          name: f["Nom élève"] || `${prenom} ${nom}`.trim() || "(sans nom)",
          phone: f["parent-telephone"] || "",
          email: f["parent-email"] || "",
          joursAbonnement,
          formula: joursAbonnement.length || 1,
          status: f["statut"] || "",
        };
      })
    );
  }, []);

  const refreshReservations = useCallback(async () => {
    const records = await airtableGetAll("reservations");
    setAssignments(
      records.map((rec) => {
        const f = rec.fields;
        return {
          id: rec.id,
          rosterId: (f["Élève"] || [])[0] || null,
          creneauId: (f["Créneau"] || [])[0] || null,
          date: f["Date"] || "",
          seriesId: f["Série"] || null,
          activite: f["Activité"] || "",
          groupe: f["Groupe"] || "",
        };
      })
    );
  }, []);

  const refreshAll = useCallback(async () => {
    await Promise.all([refreshCreneaux(), refreshRoster(), refreshReservations()]);
  }, [refreshCreneaux, refreshRoster, refreshReservations]);

  useEffect(() => {
    (async () => {
      try {
        await refreshAll();
        setApiError("");
      } catch (e) {
        console.error("Échec du chargement depuis Airtable", e);
        setApiError(e.message || "Impossible de charger les données depuis Airtable.");
      }
      // Jours fermés / comptes / journal : pas encore de table Airtable dédiée, restent en local.
      try {
        const res = await window.storage.get(STORAGE_KEY, true);
        if (res && res.value) {
          const parsed = JSON.parse(res.value);
          if (parsed.closedPeriods) setClosedPeriods(parsed.closedPeriods);
          if (parsed.accounts) setAccounts(parsed.accounts);
          if (parsed.activityLog) setActivityLog(parsed.activityLog);
        }
      } catch (e) {
        // pas encore de données locales
      }
      try {
        const personal = await window.storage.get("current-account", false);
        if (personal && personal.value) setCurrentAccountId(personal.value);
      } catch (e) {
        // pas encore choisi
      } finally {
        setLoaded(true);
      }
    })();
  }, [refreshAll]);

  const persistLocal = useCallback(async (data) => {
    try {
      await window.storage.set(STORAGE_KEY, JSON.stringify(data), true);
    } catch (e) {
      console.error("Échec de la sauvegarde locale", e);
    }
  }, []);

  const setActiveAccount = (id) => {
    setCurrentAccountId(id);
    window.storage.set("current-account", id || "", false).catch(() => {});
  };

  const accountsById = useMemo(() => {
    const map = {};
    accounts.forEach((a) => (map[a.id] = a));
    return map;
  }, [accounts]);

  const currentAccountName = accountsById[currentAccountId]?.name || null;

  const logAction = (text) =>
    [{ id: uid("log"), ts: new Date().toISOString(), who: currentAccountName || "Non identifié", text }, ...activityLog].slice(0, 50);

  const rosterById = useMemo(() => {
    const map = {};
    roster.forEach((r) => (map[r.id] = r));
    return map;
  }, [roster]);

  const creneauById = useMemo(() => {
    const map = {};
    Object.values(creneauxByDay).forEach((list) => list.forEach((c) => (map[c.id] = c)));
    return map;
  }, [creneauxByDay]);

  // --- comptage (fonctionne sur n'importe quelle semaine, pas seulement celle affichée) ---
  const countForDate = useCallback(
    (iso, creneauId, excludeAssignmentId) =>
      assignments.filter((a) => a.date === iso && a.creneauId === creneauId && a.id !== excludeAssignmentId).length,
    [assignments]
  );

  const weeklyCountInWeekOf = useCallback(
    (rosterId, referenceIso, excludeAssignmentId) => {
      const wset = new Set(weekDatesForIso(referenceIso));
      return assignments.filter((a) => a.rosterId === rosterId && wset.has(a.date) && a.id !== excludeAssignmentId).length;
    },
    [assignments]
  );

  const weeklyCountForRoster = (rosterId, excludeAssignmentId) => weeklyCountInWeekOf(rosterId, isoDate(monday), excludeAssignmentId);

  // --- occupation de la semaine affichée (pour le rendu) ---
  const occupancy = useMemo(() => {
    const map = {};
    weekDates.forEach((d) => {
      const iso = isoDate(d);
      const wd = WEEKDAY_NAMES[d.getDay() - 1];
      map[iso] = {};
      (creneauxByDay[wd] || []).forEach((c) => (map[iso][c.id] = []));
    });
    assignments.forEach((a) => {
      if (map[a.date] && map[a.date][a.creneauId] !== undefined) {
        const student = rosterById[a.rosterId];
        map[a.date][a.creneauId].push({
          assignmentId: a.id,
          rosterId: a.rosterId,
          name: student ? student.name : "?",
          formula: student ? student.formula : 1,
          activite: a.activite || "",
          groupe: a.groupe || "",
        });
      }
    });
    return map;
  }, [assignments, weekDates, rosterById, creneauxByDay]);

  const closedByIso = useMemo(() => {
    const map = {};
    weekDates.forEach((d) => {
      const iso = isoDate(d);
      map[iso] = findClosedEntry(iso, closedPeriods);
    });
    return map;
  }, [weekDates, closedPeriods]);

  const totalCapacity = weekDates.reduce((sum, d) => {
    const iso = isoDate(d);
    if (closedByIso[iso]) return sum;
    const wd = WEEKDAY_NAMES[d.getDay() - 1];
    return sum + (creneauxByDay[wd] || []).length * CAPACITY;
  }, 0);
  const totalOccupied = weekDates.reduce(
    (sum, d) => sum + Object.values(occupancy[isoDate(d)] || {}).reduce((s, l) => s + l.length, 0),
    0
  );

  // --- modale de réservation ---
  const openBooking = (presetIso, presetCreneauId) => {
    setBookingError("");
    setBookingSummary(null);
    setBooking(emptyBookingDraft(presetIso, presetCreneauId));
  };

  const openEditBooking = (assignmentId) => {
    const a = assignments.find((x) => x.id === assignmentId);
    if (!a) return;
    setBookingError("");
    setBookingSummary(null);
    setDeletePanelOpen(false);
    const futureInSeries = a.seriesId ? assignments.filter((x) => x.seriesId === a.seriesId && x.date >= a.date).length : 1;
    setBooking({
      ...emptyBookingDraft(a.date, a.creneauId),
      assignmentId: a.id,
      originalDate: a.date,
      originalCreneauId: a.creneauId,
      rosterId: a.rosterId,
      query: rosterById[a.rosterId]?.name || "",
      activite: a.activite || "",
      groupe: a.groupe || "",
      seriesId: a.seriesId || null,
      seriesFutureCount: futureInSeries,
    });
  };

  const closeBooking = () => {
    setBooking(null);
    setBookingSummary(null);
    setDeletePanelOpen(false);
  };

  const rosterMatches = useMemo(() => {
    if (!booking || booking.rosterId || !booking.query.trim()) return [];
    const q = booking.query.trim().toLowerCase();
    return roster.filter((r) => r.name.toLowerCase().includes(q)).slice(0, 6);
  }, [booking, roster]);

  const selectRosterForBooking = (rosterId) => {
    setBooking((b) => ({ ...b, rosterId, query: rosterById[rosterId]?.name || b.query, creatingNew: false }));
    setBookingError("");
  };

  const startCreatingNewFromBooking = () => setBooking((b) => ({ ...b, creatingNew: true, newPrenom: b.query, newNom: "" }));

  const confirmCreateFromBooking = async () => {
    if (!booking.newPrenom.trim() || !booking.newNom.trim()) {
      setBookingError("Merci d'indiquer le prénom et le nom du nouvel élève.");
      return;
    }
    try {
      const record = await airtableCreate("eleves", {
        "eleve-prenom": booking.newPrenom.trim(),
        "eleve-nom": booking.newNom.trim(),
        "parent-telephone": booking.newPhone.trim() || undefined,
        "parent-email": booking.newEmail.trim() || undefined,
        statut: "À rappeler",
      });
      await refreshRoster();
      setBooking((b) => ({
        ...b,
        rosterId: record.id,
        query: `${booking.newPrenom.trim()} ${booking.newNom.trim()}`,
        creatingNew: false,
      }));
      setBookingError("");
    } catch (e) {
      setBookingError("Échec de la création de la fiche élève : " + e.message);
    }
  };

  // Création d'une NOUVELLE inscription : se répète automatiquement sur 4 semaines (1 mois d'abonnement)
  const saveNewBooking = async () => {
    const student = rosterById[booking.rosterId];
    const results = [];
    const toCreate = [];
    let simulated = [...assignments];

    RECURRENCE_OFFSETS.forEach((offset) => {
      const targetDate = isoDate(addDays(new Date(booking.date + "T00:00:00"), offset));
      const closed = findClosedEntry(targetDate, closedPeriods);
      if (closed) {
        results.push({ date: targetDate, ok: false, reason: REASON_LABELS.ferme(closed.label) });
        return;
      }
      const dup = simulated.some((a) => a.rosterId === booking.rosterId && a.date === targetDate && a.creneauId === booking.creneauId);
      if (dup) {
        results.push({ date: targetDate, ok: false, reason: REASON_LABELS.doublon() });
        return;
      }
      const cap = simulated.filter((a) => a.date === targetDate && a.creneauId === booking.creneauId).length;
      if (cap >= CAPACITY) {
        results.push({ date: targetDate, ok: false, reason: REASON_LABELS.complet() });
        return;
      }
      if (student) {
        const wset = new Set(weekDatesForIso(targetDate));
        const weeklyCount = simulated.filter((a) => a.rosterId === booking.rosterId && wset.has(a.date)).length;
        if (weeklyCount >= student.formula) {
          results.push({ date: targetDate, ok: false, reason: REASON_LABELS.quota() });
          return;
        }
      }
      simulated.push({ id: "tmp-" + toCreate.length, rosterId: booking.rosterId, date: targetDate, creneauId: booking.creneauId });
      toCreate.push(targetDate);
      results.push({ date: targetDate, ok: true });
    });

    if (toCreate.length > 0) {
      const seriesId = uid("s");
      try {
        await airtableCreateMany(
          "reservations",
          toCreate.map((targetDate) => ({
            "Élève": [booking.rosterId],
            "Créneau": [booking.creneauId],
            Date: targetDate,
            Série: seriesId,
            Activité: booking.activite || undefined,
            Groupe: booking.groupe || undefined,
          }))
        );
        const nextLog = logAction(
          `Inscription créée — ${student ? student.name : "?"} — ${weekdayNameForDate(booking.date)} (${toCreate.length}/4 semaines)`
        );
        setActivityLog(nextLog);
        persistLocal({ closedPeriods, accounts, activityLog: nextLog });
        await refreshReservations();
      } catch (e) {
        setBookingError("Échec de l'enregistrement : " + e.message);
        return;
      }
    }
    setBookingSummary(results);
  };

  // Modification d'une inscription EXISTANTE : le jour et le créneau sont figés jusqu'au renouvellement
  // (choisis une fois à la création de l'abonnement) — seuls l'activité et le groupe restent modifiables.
  const saveEditBooking = async () => {
    const original = assignments.find((a) => a.id === booking.assignmentId);
    const sameActivite = (booking.activite || "") === (original?.activite || "");
    const sameGroupe = (booking.groupe || "") === (original?.groupe || "");
    if (sameActivite && sameGroupe) {
      setBookingError("Aucun changement à enregistrer.");
      return;
    }
    try {
      await airtableUpdate("reservations", booking.assignmentId, {
        Activité: booking.activite || undefined,
        Groupe: booking.groupe || undefined,
      });
      await refreshReservations();
      closeBooking();
    } catch (e) {
      setBookingError("Échec de la modification : " + e.message);
    }
  };

  const removeSingleBooking = async () => {
    const student = rosterById[booking.rosterId];
    try {
      await airtableDelete("reservations", booking.assignmentId);
      const nextLog = logAction(
        `Créneau retiré (une occurrence) — ${student ? student.name : "?"} — ${weekdayNameForDate(booking.originalDate)} ${shortLabel(new Date(booking.originalDate + "T00:00:00"))}`
      );
      setActivityLog(nextLog);
      persistLocal({ closedPeriods, accounts, activityLog: nextLog });
      await refreshReservations();
    } catch (e) {
      setBookingError("Échec de la suppression : " + e.message);
      return;
    }
    setDeletePanelOpen(false);
    closeBooking();
  };

  const removeSeriesFromHere = async () => {
    const student = rosterById[booking.rosterId];
    const toRemove = assignments.filter((a) => a.seriesId && a.seriesId === booking.seriesId && a.date >= booking.originalDate);
    try {
      await airtableDeleteMany("reservations", toRemove.map((a) => a.id));
      const nextLog = logAction(
        `Créneau retiré (à partir de cette semaine) — ${student ? student.name : "?"} — depuis ${weekdayNameForDate(booking.originalDate)} ${shortLabel(new Date(booking.originalDate + "T00:00:00"))} (${booking.seriesFutureCount} semaine(s))`
      );
      setActivityLog(nextLog);
      persistLocal({ closedPeriods, accounts, activityLog: nextLog });
      await refreshReservations();
    } catch (e) {
      setBookingError("Échec de la suppression : " + e.message);
      return;
    }
    setDeletePanelOpen(false);
    closeBooking();
  };

  // --- base élèves (CRUD Airtable) ---
  const openNewRoster = () => {
    setRosterError("");
    setRosterModal(emptyRosterDraft());
  };
  const openEditRoster = (r) => {
    setRosterError("");
    setRosterModal({
      editingId: r.id,
      prenom: r.prenom,
      nom: r.nom,
      phone: r.phone,
      email: r.email,
      joursAbonnement: r.joursAbonnement,
      status: r.status,
    });
  };
  const closeRosterModal = () => setRosterModal(null);

  const saveRosterModal = async () => {
    if (!rosterModal.prenom.trim() || !rosterModal.nom.trim()) {
      setRosterError("Merci d'indiquer le prénom et le nom de l'élève.");
      return;
    }
    const fields = {
      "eleve-prenom": rosterModal.prenom.trim(),
      "eleve-nom": rosterModal.nom.trim(),
      "parent-telephone": rosterModal.phone.trim() || undefined,
      "parent-email": rosterModal.email.trim() || undefined,
      statut: rosterModal.status,
    };
    WEEKDAY_NAMES.forEach((d) => {
      fields[`eleve-jour-${d.toLowerCase()}`] = rosterModal.joursAbonnement.includes(d) ? "true" : "false";
    });
    try {
      if (rosterModal.editingId) {
        await airtableUpdate("eleves", rosterModal.editingId, fields);
      } else {
        await airtableCreate("eleves", fields);
      }
      await refreshRoster();
      setRosterModal(null);
    } catch (e) {
      setRosterError("Échec de l'enregistrement : " + e.message);
    }
  };

  const deleteRosterEntry = async (id) => {
    if (confirmDeleteRoster !== id) {
      setConfirmDeleteRoster(id);
      setTimeout(() => setConfirmDeleteRoster((cur) => (cur === id ? null : cur)), 3000);
      return;
    }
    const student = rosterById[id];
    const linked = assignments.filter((a) => a.rosterId === id);
    try {
      await airtableDeleteMany("reservations", linked.map((a) => a.id));
      await airtableDelete("eleves", id);
      const nextLog = logAction(`Fiche élève supprimée — ${student ? student.name : id}`);
      setActivityLog(nextLog);
      persistLocal({ closedPeriods, accounts, activityLog: nextLog });
      await Promise.all([refreshRoster(), refreshReservations()]);
    } catch (e) {
      console.error(e);
    }
    setConfirmDeleteRoster(null);
  };

  // --- comptes (équipe / accountability — reste en local pour l'instant) ---
  const openNewAccount = () => {
    setAccountError("");
    setAccountModal({ editingId: null, name: "", role: "Animateur" });
  };
  const openEditAccount = (acc) => {
    setAccountError("");
    setAccountModal({ editingId: acc.id, name: acc.name, role: acc.role });
  };
  const closeAccountModal = () => setAccountModal(null);

  const saveAccountModal = () => {
    if (!accountModal.name.trim()) {
      setAccountError("Merci d'indiquer un nom.");
      return;
    }
    let next;
    if (accountModal.editingId) {
      next = accounts.map((a) => (a.id === accountModal.editingId ? { ...a, name: accountModal.name.trim(), role: accountModal.role } : a));
    } else {
      next = [...accounts, { id: uid("acc"), name: accountModal.name.trim(), role: accountModal.role }];
    }
    setAccounts(next);
    persistLocal({ closedPeriods, accounts: next, activityLog });
    setAccountModal(null);
  };

  const deleteAccount = (id) => {
    if (confirmDeleteAccount !== id) {
      setConfirmDeleteAccount(id);
      setTimeout(() => setConfirmDeleteAccount((cur) => (cur === id ? null : cur)), 3000);
      return;
    }
    const next = accounts.filter((a) => a.id !== id);
    setAccounts(next);
    if (currentAccountId === id) setActiveAccount(null);
    persistLocal({ closedPeriods, accounts: next, activityLog });
    setConfirmDeleteAccount(null);
  };

  // --- créneaux (CRUD Airtable — remplace l'ancien "Renommer les horaires" en local) ---
  const openSettings = () => {
    setCreneauError({});
    setSettingsOpen(true);
  };

  const renameCreneau = async (creneauId, newHoraire) => {
    try {
      await airtableUpdate("creneaux", creneauId, { Horaire: newHoraire });
      await refreshCreneaux();
    } catch (e) {
      console.error(e);
    }
  };

  const addCreneau = async (day) => {
    try {
      await airtableCreate("creneaux", { Jour: day, Horaire: "Nouveau créneau" });
      await refreshCreneaux();
    } catch (e) {
      setCreneauError((prev) => ({ ...prev, [day]: "Échec de la création : " + e.message }));
    }
  };

  // Contrairement à l'ancienne version (array local), n'importe quel créneau peut être retiré,
  // pas seulement le dernier — puisque chaque créneau est un vrai enregistrement Airtable identifié
  // par son id, il n'y a plus de risque de décalage/renumérotation.
  const removeCreneau = async (day, creneauId) => {
    const blockers = assignments.filter((a) => a.creneauId === creneauId);
    if (blockers.length > 0) {
      const names = [...new Set(blockers.map((a) => rosterById[a.rosterId]?.name || "?"))];
      setCreneauError((prev) => ({
        ...prev,
        [day]: `Impossible : ${blockers.length} réservation(s) sur ce créneau (${names.join(", ")}). Déplacez-les ou retirez-les d'abord.`,
      }));
      return;
    }
    try {
      await airtableDelete("creneaux", creneauId);
      await refreshCreneaux();
      setCreneauError((prev) => ({ ...prev, [day]: "" }));
    } catch (e) {
      setCreneauError((prev) => ({ ...prev, [day]: "Échec de la suppression : " + e.message }));
    }
  };

  // --- jours fermés (reste en local pour l'instant) ---
  const addClosedPeriod = () => {
    if (!closedForm.label.trim()) {
      setClosedError("Merci d'indiquer un libellé (ex. « Vacances de la Toussaint »).");
      return;
    }
    if (!closedForm.start) {
      setClosedError("Merci de choisir au moins une date de début.");
      return;
    }
    const start = closedForm.start;
    const end = closedForm.end || closedForm.start;
    if (end < start) {
      setClosedError("La date de fin doit être après la date de début.");
      return;
    }
    const next = [...closedPeriods, { id: uid("c"), label: closedForm.label.trim(), start, end }];
    setClosedPeriods(next);
    persistLocal({ closedPeriods: next, accounts, activityLog });
    setClosedForm({ label: "", start: "", end: "" });
    setClosedError("");
  };

  const deleteClosedPeriod = (id) => {
    if (confirmDeleteClosed !== id) {
      setConfirmDeleteClosed(id);
      setTimeout(() => setConfirmDeleteClosed((cur) => (cur === id ? null : cur)), 3000);
      return;
    }
    const next = closedPeriods.filter((c) => c.id !== id);
    setClosedPeriods(next);
    persistLocal({ closedPeriods: next, accounts, activityLog });
    setConfirmDeleteClosed(null);
  };

  const addPresetHolidays = () => {
    const existingKeys = new Set(closedPeriods.map((c) => `${c.label}|${c.start}`));
    const toAdd = ZONE_C_2026_2027.filter((h) => !existingKeys.has(`${h.label}|${h.start}`)).map((h) => ({ id: uid("c"), ...h }));
    if (toAdd.length === 0) return;
    const next = [...closedPeriods, ...toAdd];
    setClosedPeriods(next);
    persistLocal({ closedPeriods: next, accounts, activityLog });
  };

  const weekRoster = useMemo(() => {
    const ids = new Set(assignments.filter((a) => weekIsoSet.has(a.date)).map((a) => a.rosterId));
    return roster
      .filter((r) => ids.has(r.id))
      .filter((r) => r.name.toLowerCase().includes(search.toLowerCase()))
      .sort((a, b) => a.name.localeCompare(b.name, "fr"));
  }, [roster, assignments, weekIsoSet, search]);

  const filteredRoster = useMemo(
    () =>
      roster
        .filter((r) => (rosterFilter === "tous" ? true : r.status === rosterFilter))
        .filter((r) => r.name.toLowerCase().includes(rosterSearch.toLowerCase()))
        .sort((a, b) => a.name.localeCompare(b.name, "fr")),
    [roster, rosterFilter, rosterSearch]
  );

  const weekRangeLabel = `${shortLabel(weekDates[0])} – ${shortLabel(weekDates[5])} ${weekDates[5].getFullYear()}`;
  const isCurrentWeek = isoDate(monday) === isoDate(getMonday(new Date()));

  if (!loaded) {
    return <div style={{ padding: 40, fontFamily: "Georgia, serif", color: "#1F2A38" }}>Chargement du planning…</div>;
  }

  const StatusBadge = ({ status }) => {
    const colors = STATUT_COLORS[String(status || "").toLowerCase()] || { bg: "#F1EDE5", fg: "#8A8371" };
    return (
      <span style={{ fontSize: 11.5, fontWeight: 600, padding: "2px 8px", borderRadius: 999, background: colors.bg, color: colors.fg }}>
        {status || "—"}
      </span>
    );
  };

  return (
    <div style={{ background: "#F5F3ED", minHeight: "100%", padding: "28px 24px 60px" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=Inter:wght@400;500;600;700&display=swap');
        .pa-root, .pa-root * { box-sizing: border-box; font-family: 'Inter', system-ui, sans-serif; }
        .pa-display { font-family: 'Fraunces', Georgia, serif; }
        .pa-btn { border: none; cursor: pointer; border-radius: 8px; font-weight: 600; transition: transform .08s ease, opacity .15s ease; }
        .pa-btn:active { transform: scale(0.97); }
        .pa-btn:hover { opacity: 0.88; }
        .pa-btn:disabled { opacity: 0.4; cursor: not-allowed; }
        .pa-chip { display: inline-flex; align-items: center; gap: 5px; padding: 4px 9px; border-radius: 999px; font-size: 12.5px; font-weight: 500; cursor: pointer; border: 1px solid transparent; }
        .pa-chip:hover { border-color: currentColor; }
        .pa-card { background: #FFFFFF; border-radius: 12px; border: 1px solid #E4E0D5; }
        .pa-input, .pa-select {
          width: 100%; padding: 9px 11px; border-radius: 7px; border: 1px solid #D6D1C2;
          font-size: 14.5px; background: #FEFDFB; color: #1F2A38;
        }
        .pa-input:focus, .pa-select:focus { outline: 2px solid #3F6B52; outline-offset: 1px; }
        .pa-table th { text-align: left; font-weight: 600; font-size: 12.5px; letter-spacing: .01em; color: #6B6455; padding: 8px 10px; border-bottom: 1px solid #E4E0D5; }
        .pa-table td { padding: 10px; border-bottom: 1px solid #EFECE2; font-size: 14px; vertical-align: top; }
        .pa-overlay { position: fixed; inset: 0; background: rgba(31,42,56,0.45); display: flex; align-items: center; justify-content: center; z-index: 50; padding: 16px; }
        .pa-modal { background: #FEFDFB; border-radius: 14px; padding: 26px; width: 100%; max-width: 480px; max-height: 88vh; overflow-y: auto; }
        .pa-navbtn { background: #EFECE2; color: #1F2A38; width: 34px; height: 34px; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 15px; }
        .pa-tab { padding: 8px 16px; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; border: none; }
        .pa-match { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 9px 10px; border-radius: 8px; cursor: pointer; border: 1px solid #E4E0D5; background: #FEFDFB; margin-bottom: 6px; }
        .pa-match:hover { border-color: #3F6B52; }
      `}</style>

      <div className="pa-root">
        {apiError && (
          <div className="pa-card" style={{ padding: 12, marginBottom: 16, borderTop: "3px solid #B3462F", background: "#FBF6F2" }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#B3462F" }}>Connexion à Airtable impossible</div>
            <div style={{ fontSize: 12.5, color: "#6B6455", marginTop: 2 }}>{apiError}</div>
          </div>
        )}

        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: 16, marginBottom: 18 }}>
          <div>
            <h1 className="pa-display" style={{ fontSize: 30, fontWeight: 600, color: "#1F2A38", margin: 0 }}>Planning des ateliers</h1>
            <p style={{ margin: "6px 0 0", color: "#6B6455", fontSize: 14.5 }}>
              {roster.length} élève{roster.length !== 1 ? "s" : ""} dans la base · {weekRoster.length} inscrit{weekRoster.length !== 1 ? "s" : ""} cette semaine
            </p>
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <select
              className="pa-select"
              value={currentAccountId || ""}
              onChange={(e) => setActiveAccount(e.target.value || null)}
              style={{ width: "auto", maxWidth: 200, fontSize: 13, padding: "9px 10px" }}
            >
              <option value="">Connecté en tant que…</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.name} ({a.role})</option>
              ))}
            </select>
            <button className="pa-btn" onClick={openSettings} style={{ background: "#EFECE2", color: "#1F2A38", padding: "10px 16px", fontSize: 14 }}>
              Gérer les créneaux
            </button>
            <button className="pa-btn" onClick={() => openBooking()} style={{ background: "#3F6B52", color: "#fff", padding: "10px 18px", fontSize: 14 }}>
              + Nouvelle inscription
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
          <button className="pa-tab" onClick={() => setView("planning")} style={{ background: view === "planning" ? "#1F2A38" : "#EFECE2", color: view === "planning" ? "#fff" : "#1F2A38" }}>
            Planning
          </button>
          <button className="pa-tab" onClick={() => setView("roster")} style={{ background: view === "roster" ? "#1F2A38" : "#EFECE2", color: view === "roster" ? "#fff" : "#1F2A38" }}>
            Base élèves
          </button>
          <button className="pa-tab" onClick={() => setView("closed")} style={{ background: view === "closed" ? "#1F2A38" : "#EFECE2", color: view === "closed" ? "#fff" : "#1F2A38" }}>
            Jours fermés{closedPeriods.length > 0 ? ` (${closedPeriods.length})` : ""}
          </button>
          <button className="pa-tab" onClick={() => setView("accounts")} style={{ background: view === "accounts" ? "#1F2A38" : "#EFECE2", color: view === "accounts" ? "#fff" : "#1F2A38" }}>
            Comptes{accounts.length > 0 ? ` (${accounts.length})` : ""}
          </button>
        </div>

        {view === "planning" && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 22 }}>
              <button className="pa-btn pa-navbtn" onClick={() => setMonday(addDays(monday, -7))} aria-label="Semaine précédente">‹</button>
              <div className="pa-card" style={{ padding: "9px 16px", display: "flex", alignItems: "center", gap: 10 }}>
                <span className="pa-display" style={{ fontSize: 15.5, fontWeight: 600, color: "#1F2A38" }}>Semaine du {weekRangeLabel}</span>
                {!isCurrentWeek && (
                  <button className="pa-btn" onClick={() => setMonday(getMonday(new Date()))} style={{ background: "#EFECE2", color: "#3F6B52", padding: "4px 10px", fontSize: 12 }}>
                    Aujourd'hui
                  </button>
                )}
              </div>
              <button className="pa-btn pa-navbtn" onClick={() => setMonday(addDays(monday, 7))} aria-label="Semaine suivante">›</button>
            </div>

            <p style={{ fontSize: 12.5, color: "#8A8371", marginTop: -14, marginBottom: 18 }}>
              Une nouvelle inscription se répète automatiquement sur 4 semaines (un mois d'abonnement).
            </p>

            <div style={{ display: "grid", gridTemplateColumns: `repeat(${weekDates.length}, minmax(160px, 1fr))`, gap: 12, overflowX: "auto", marginBottom: 34 }}>
              {weekDates.map((date) => {
                const iso = isoDate(date);
                const wd = WEEKDAY_NAMES[date.getDay() - 1];
                const dayCreneaux = creneauxByDay[wd] || [];
                const dayTotal = dayCreneaux.length * CAPACITY;
                const dayOccupied = Object.values(occupancy[iso] || {}).reduce((s, list) => s + list.length, 0);
                const closedEntry = closedByIso[iso];

                if (closedEntry) {
                  const strandedBookings = Object.values(occupancy[iso] || {}).flat();
                  return (
                    <div key={iso} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                      <div style={{ padding: "2px 4px" }}>
                        <div className="pa-display" style={{ fontSize: 16.5, fontWeight: 600, color: "#1F2A38" }}>
                          {wd} <span style={{ fontWeight: 500, color: "#8A8371", fontSize: 13.5 }}>{shortLabel(date)}</span>
                        </div>
                      </div>
                      <div className="pa-card" style={{ padding: 12, borderTop: "3px solid #B3462F", background: "#FBF6F2" }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: "#B3462F", marginBottom: 4 }}>Fermé</div>
                        <div style={{ fontSize: 12.5, color: "#6B6455" }}>{closedEntry.label}</div>
                        {strandedBookings.length > 0 && (
                          <div style={{ marginTop: 10 }}>
                            <div style={{ fontSize: 11.5, color: "#B3462F", fontWeight: 600, marginBottom: 6 }}>À déplacer :</div>
                            <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                              {strandedBookings.map((s) => (
                                <span key={s.assignmentId} className="pa-chip" onClick={() => openEditBooking(s.assignmentId)} style={{ background: "#fff", color: "#1F2A38", borderColor: "#E4C9BE" }}>
                                  {s.name}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                }

                return (
                  <div key={iso} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    <div style={{ padding: "2px 4px" }}>
                      <div className="pa-display" style={{ fontSize: 16.5, fontWeight: 600, color: "#1F2A38" }}>
                        {wd} <span style={{ fontWeight: 500, color: "#8A8371", fontSize: 13.5 }}>{shortLabel(date)}</span>
                      </div>
                      <div style={{ fontSize: 12, color: "#8A8371" }}>{dayOccupied}/{dayTotal} places</div>
                    </div>
                    {dayCreneaux.map((c) => {
                      const occ = (occupancy[iso] && occupancy[iso][c.id]) || [];
                      const count = occ.length;
                      const ratio = count / CAPACITY;
                      const full = count >= CAPACITY;
                      const accent = full ? "#B3462F" : ratio >= 0.75 ? "#C98A2C" : "#3F6B52";
                      return (
                        <div key={c.id} className="pa-card" style={{ padding: 12, borderTop: `3px solid ${accent}` }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
                            <span style={{ fontSize: 13.5, fontWeight: 600, color: "#1F2A38" }}>{c.horaire}</span>
                            <span style={{ fontSize: 12, color: accent, fontWeight: 600 }}>{count}/{CAPACITY}</span>
                          </div>
                          <div style={{ height: 5, background: "#EFECE2", borderRadius: 4, overflow: "hidden", marginBottom: 10 }}>
                            <div style={{ height: "100%", width: `${Math.min(ratio, 1) * 100}%`, background: accent }} />
                          </div>
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 5, minHeight: 4 }}>
                            {occ.map((s) => (
                              <span
                                key={s.assignmentId}
                                className="pa-chip"
                                onClick={() => openEditBooking(s.assignmentId)}
                                style={{ background: "#F5F3ED", color: "#1F2A38" }}
                                title="Modifier cette réservation"
                              >
                                {s.name}
                                {s.formula === 2 && <span style={{ color: "#8A8371" }}>·2</span>}
                                {s.groupe && <span style={{ color: "#8A8371" }}> · {s.groupe}</span>}
                                {s.activite && <span style={{ color: "#8A8371" }}> · {s.activite}</span>}
                              </span>
                            ))}
                          </div>
                          {!full && (
                            <button className="pa-btn" onClick={() => openBooking(iso, c.id)} style={{ marginTop: 9, background: "transparent", color: accent, fontSize: 12.5, padding: "4px 0" }}>
                              + Inscrire ici
                            </button>
                          )}
                          {full && <div style={{ marginTop: 9, fontSize: 12, color: "#B3462F", fontWeight: 600 }}>Complet</div>}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>

            <div className="pa-card" style={{ padding: 18 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10, marginBottom: 12 }}>
                <h2 className="pa-display" style={{ fontSize: 19, fontWeight: 600, color: "#1F2A38", margin: 0 }}>Élèves de la semaine</h2>
                <input className="pa-input" placeholder="Rechercher un élève…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 220 }} />
              </div>
              {weekRoster.length === 0 ? (
                <p style={{ color: "#8A8371", fontSize: 14, padding: "12px 4px" }}>Aucun élève inscrit sur cette semaine.</p>
              ) : (
                <table className="pa-table" style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr>
                      <th>Nom</th>
                      <th>Formule</th>
                      <th>Statut</th>
                      <th>Créneaux cette semaine</th>
                    </tr>
                  </thead>
                  <tbody>
                    {weekRoster.map((r) => {
                      const bookings = assignments.filter((a) => a.rosterId === r.id && weekIsoSet.has(a.date));
                      return (
                        <tr key={r.id}>
                          <td style={{ fontWeight: 600, color: "#1F2A38" }}>{r.name}</td>
                          <td>{r.formula} créneau{r.formula > 1 ? "x" : ""} / semaine</td>
                          <td><StatusBadge status={r.status} /></td>
                          <td>
                            <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                              {bookings.map((a) => {
                                const d = new Date(a.date + "T00:00:00");
                                const wd = WEEKDAY_NAMES[d.getDay() - 1];
                                return (
                                  <span key={a.id} className="pa-chip" onClick={() => openEditBooking(a.id)} style={{ background: "#F5F3ED", color: "#1F2A38" }}>
                                    {wd} {shortLabel(d)} · {creneauById[a.creneauId]?.horaire || "?"}
                                  </span>
                                );
                              })}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}

        {view === "roster" && (
          <div className="pa-card" style={{ padding: 18 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10, marginBottom: 14 }}>
              <h2 className="pa-display" style={{ fontSize: 19, fontWeight: 600, color: "#1F2A38", margin: 0 }}>Base élèves</h2>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {["tous", ...STATUTS].map((f) => (
                  <button key={f} className="pa-btn" onClick={() => setRosterFilter(f)} style={{ background: rosterFilter === f ? "#1F2A38" : "#EFECE2", color: rosterFilter === f ? "#fff" : "#1F2A38", padding: "7px 13px", fontSize: 12.5 }}>
                    {f === "tous" ? "Tous" : f}
                  </button>
                ))}
                <input className="pa-input" placeholder="Rechercher…" value={rosterSearch} onChange={(e) => setRosterSearch(e.target.value)} style={{ maxWidth: 180 }} />
                <button className="pa-btn" onClick={openNewRoster} style={{ background: "#3F6B52", color: "#fff", padding: "9px 15px", fontSize: 13.5 }}>
                  + Nouvel élève
                </button>
              </div>
            </div>

            {filteredRoster.length === 0 ? (
              <p style={{ color: "#8A8371", fontSize: 14, padding: "12px 4px" }}>Aucun élève dans la base.</p>
            ) : (
              <table className="pa-table" style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th>Nom</th>
                    <th>Téléphone</th>
                    <th>Email</th>
                    <th>Jours d'abonnement</th>
                    <th>Statut</th>
                    <th>Cette semaine</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRoster.map((r) => {
                    const weeklyCount = weeklyCountForRoster(r.id, null);
                    return (
                      <tr key={r.id}>
                        <td style={{ fontWeight: 600, color: "#1F2A38" }}>{r.name}</td>
                        <td>{r.phone || "—"}</td>
                        <td>{r.email || "—"}</td>
                        <td>{r.joursAbonnement.length ? r.joursAbonnement.join(", ") : "—"}</td>
                        <td><StatusBadge status={r.status} /></td>
                        <td style={{ color: weeklyCount >= r.formula ? "#C98A2C" : "#6B6455", fontWeight: 600 }}>{weeklyCount}/{r.formula}</td>
                        <td>
                          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                            <button className="pa-btn" onClick={() => openEditRoster(r)} style={{ background: "#EFECE2", color: "#1F2A38", padding: "6px 11px", fontSize: 12.5 }}>
                              Modifier
                            </button>
                            <button
                              className="pa-btn"
                              onClick={() => deleteRosterEntry(r.id)}
                              style={{ background: confirmDeleteRoster === r.id ? "#B3462F" : "#F5F3ED", color: confirmDeleteRoster === r.id ? "#fff" : "#B3462F", padding: "6px 11px", fontSize: 12.5 }}
                            >
                              {confirmDeleteRoster === r.id ? "Confirmer ?" : "Supprimer"}
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}

        {view === "closed" && (
          <div className="pa-card" style={{ padding: 18 }}>
            <h2 className="pa-display" style={{ fontSize: 19, fontWeight: 600, color: "#1F2A38", margin: "0 0 4px" }}>Jours fermés</h2>
            <p style={{ fontSize: 13, color: "#8A8371", marginTop: 0, marginBottom: 14 }}>
              Bloquez des dates ou des périodes (vacances scolaires, jours fériés). Ces jours disparaissent de la grille de réservation ; les inscriptions déjà posées dessus restent visibles pour être déplacées. (Stocké en local pour l'instant, pas encore dans Airtable.)
            </p>

            <div className="pa-card" style={{ padding: 14, marginBottom: 16, background: "#F1EDE0", border: "1px solid #E4D9BD" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
                <div>
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: "#1F2A38" }}>Vacances scolaires zone C (Paris) 2026-2027 + jours fériés</div>
                  <div style={{ fontSize: 12, color: "#6B6455", marginTop: 2 }}>Toussaint, Noël, hiver, printemps, été, Armistice, Lundi de Pâques, pont de l'Ascension — 8 fermetures, ajoutées en un clic.</div>
                </div>
                <button className="pa-btn" onClick={addPresetHolidays} style={{ background: "#1F2A38", color: "#fff", padding: "9px 16px", fontSize: 13, whiteSpace: "nowrap" }}>
                  Ajouter le calendrier 2026-2027
                </button>
              </div>
            </div>

            <div className="pa-card" style={{ padding: 14, marginBottom: 20, background: "#FAF9F5" }}>
              <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr 1fr auto", gap: 8, alignItems: "end" }}>
                <div>
                  <label style={{ fontSize: 12.5, fontWeight: 600, color: "#6B6455", display: "block", marginBottom: 5 }}>Libellé</label>
                  <input className="pa-input" placeholder="Ex. Vacances de la Toussaint" value={closedForm.label} onChange={(e) => setClosedForm((f) => ({ ...f, label: e.target.value }))} />
                </div>
                <div>
                  <label style={{ fontSize: 12.5, fontWeight: 600, color: "#6B6455", display: "block", marginBottom: 5 }}>Début</label>
                  <input className="pa-input" type="date" value={closedForm.start} onChange={(e) => setClosedForm((f) => ({ ...f, start: e.target.value }))} />
                </div>
                <div>
                  <label style={{ fontSize: 12.5, fontWeight: 600, color: "#6B6455", display: "block", marginBottom: 5 }}>Fin (optionnel)</label>
                  <input className="pa-input" type="date" value={closedForm.end} onChange={(e) => setClosedForm((f) => ({ ...f, end: e.target.value }))} />
                </div>
                <button className="pa-btn" onClick={addClosedPeriod} style={{ background: "#3F6B52", color: "#fff", padding: "9px 14px", fontSize: 13.5 }}>
                  Ajouter
                </button>
              </div>
              {closedError && <div style={{ background: "#FBEAE4", color: "#B3462F", fontSize: 12.5, padding: "8px 10px", borderRadius: 6, marginTop: 10 }}>{closedError}</div>}
            </div>

            {closedPeriods.length === 0 ? (
              <p style={{ color: "#8A8371", fontSize: 14, padding: "4px" }}>Aucun jour fermé pour l'instant.</p>
            ) : (
              <table className="pa-table" style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th>Libellé</th>
                    <th>Dates</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {[...closedPeriods]
                    .sort((a, b) => a.start.localeCompare(b.start))
                    .map((c) => (
                      <tr key={c.id}>
                        <td style={{ fontWeight: 600, color: "#1F2A38" }}>{c.label}</td>
                        <td>{formatRange(c.start, c.end)}</td>
                        <td>
                          <div style={{ display: "flex", justifyContent: "flex-end" }}>
                            <button
                              className="pa-btn"
                              onClick={() => deleteClosedPeriod(c.id)}
                              style={{ background: confirmDeleteClosed === c.id ? "#B3462F" : "#F5F3ED", color: confirmDeleteClosed === c.id ? "#fff" : "#B3462F", padding: "6px 11px", fontSize: 12.5 }}
                            >
                              {confirmDeleteClosed === c.id ? "Confirmer ?" : "Supprimer"}
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {view === "accounts" && (
          <div className="pa-card" style={{ padding: 18 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10, marginBottom: 8 }}>
              <h2 className="pa-display" style={{ fontSize: 19, fontWeight: 600, color: "#1F2A38", margin: 0 }}>Comptes de l'équipe</h2>
              <button className="pa-btn" onClick={openNewAccount} style={{ background: "#3F6B52", color: "#fff", padding: "9px 15px", fontSize: 13.5 }}>
                + Nouveau compte
              </button>
            </div>
            <p style={{ fontSize: 13, color: "#8A8371", marginTop: 0, marginBottom: 18 }}>
              Ajoutez les membres de l'équipe qui gèrent le planning. Chacun choisit son nom en haut de la page (« Connecté en tant que ») pour que les actions importantes soient tracées ci-dessous. (Stocké en local pour l'instant, pas encore dans Airtable.)
            </p>

            {accounts.length === 0 ? (
              <p style={{ color: "#8A8371", fontSize: 14, padding: "4px" }}>Aucun compte pour l'instant.</p>
            ) : (
              <table className="pa-table" style={{ width: "100%", borderCollapse: "collapse", marginBottom: 24 }}>
                <thead>
                  <tr>
                    <th>Nom</th>
                    <th>Rôle</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.map((a) => (
                    <tr key={a.id}>
                      <td style={{ fontWeight: 600, color: "#1F2A38" }}>
                        {a.name}
                        {currentAccountId === a.id && <span style={{ marginLeft: 8, fontSize: 11, color: "#3F6B52", fontWeight: 600 }}>· vous</span>}
                      </td>
                      <td>{a.role}</td>
                      <td>
                        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                          <button className="pa-btn" onClick={() => openEditAccount(a)} style={{ background: "#EFECE2", color: "#1F2A38", padding: "6px 11px", fontSize: 12.5 }}>
                            Modifier
                          </button>
                          <button
                            className="pa-btn"
                            onClick={() => deleteAccount(a.id)}
                            style={{ background: confirmDeleteAccount === a.id ? "#B3462F" : "#F5F3ED", color: confirmDeleteAccount === a.id ? "#fff" : "#B3462F", padding: "6px 11px", fontSize: 12.5 }}
                          >
                            {confirmDeleteAccount === a.id ? "Confirmer ?" : "Supprimer"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <h3 className="pa-display" style={{ fontSize: 16, fontWeight: 600, color: "#1F2A38", margin: "0 0 10px" }}>Activité récente</h3>
            {activityLog.length === 0 ? (
              <p style={{ color: "#8A8371", fontSize: 14, padding: "4px" }}>Aucune action enregistrée pour l'instant.</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {activityLog.map((log) => (
                  <div key={log.id} style={{ fontSize: 12.5, color: "#6B6455", padding: "8px 10px", background: "#F5F3ED", borderRadius: 7 }}>
                    <span style={{ fontWeight: 600, color: "#1F2A38" }}>{log.who}</span> — {log.text}
                    <span style={{ color: "#8A8371" }}> · {new Date(log.ts).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <p style={{ fontSize: 12, color: "#8A8371", marginTop: 16 }}>
          Élèves, créneaux et réservations sont partagés via Airtable : toute personne de l'équipe voit et modifie les mêmes données, en temps réel.
        </p>
      </div>

      {/* Booking modal */}
      {booking && (
        <div className="pa-overlay" onClick={closeBooking}>
          <div className="pa-modal" onClick={(e) => e.stopPropagation()}>
            {bookingSummary ? (
              <>
                <h3 className="pa-display" style={{ fontSize: 19, fontWeight: 600, color: "#1F2A38", marginTop: 0 }}>
                  Abonnement créé pour {rosterById[booking.rosterId]?.name}
                </h3>
                <p style={{ fontSize: 13, color: "#8A8371", marginTop: -4, marginBottom: 14 }}>
                  Inscription posée sur {weekdayNameForDate(booking.date)} · {creneauById[booking.creneauId]?.horaire}, répétée sur 4 semaines :
                </p>
                <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 18 }}>
                  {bookingSummary.map((r, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5 }}>
                      <span style={{ color: r.ok ? "#3F6B52" : "#C98A2C", fontWeight: 700 }}>{r.ok ? "✓" : "⚠"}</span>
                      <span style={{ color: "#1F2A38", fontWeight: 600 }}>{shortLabel(new Date(r.date + "T00:00:00"))}</span>
                      {!r.ok && <span style={{ color: "#8A8371" }}>— {r.reason}</span>}
                    </div>
                  ))}
                </div>
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <button className="pa-btn" onClick={closeBooking} style={{ background: "#3F6B52", color: "#fff", padding: "10px 18px", fontSize: 14 }}>
                    Fermer
                  </button>
                </div>
              </>
            ) : (
              <>
                <h3 className="pa-display" style={{ fontSize: 19, fontWeight: 600, color: "#1F2A38", marginTop: 0 }}>
                  {booking.assignmentId ? "Modifier la réservation" : "Inscrire un élève"}
                </h3>

                {!booking.assignmentId && !booking.rosterId && (
                  <div style={{ marginBottom: 16 }}>
                    <label style={{ fontSize: 13, fontWeight: 600, color: "#6B6455", display: "block", marginBottom: 5 }}>Nom de l'élève</label>
                    <input
                      className="pa-input"
                      autoFocus
                      value={booking.query}
                      onChange={(e) => setBooking((b) => ({ ...b, query: e.target.value, creatingNew: false }))}
                      placeholder="Tapez pour rechercher dans la base élèves…"
                      style={{ marginBottom: 8 }}
                    />
                    {booking.query.trim() && rosterMatches.length > 0 && (
                      <div style={{ marginBottom: 8 }}>
                        {rosterMatches.map((r) => (
                          <div key={r.id} className="pa-match" onClick={() => selectRosterForBooking(r.id)}>
                            <div>
                              <div style={{ fontWeight: 600, color: "#1F2A38", fontSize: 14 }}>{r.name}</div>
                              <div style={{ fontSize: 12, color: "#8A8371" }}>{r.formula} créneau{r.formula > 1 ? "x" : ""}/sem.{r.phone ? ` · ${r.phone}` : ""}</div>
                            </div>
                            <StatusBadge status={r.status} />
                          </div>
                        ))}
                      </div>
                    )}
                    {booking.query.trim() && rosterMatches.length === 0 && !booking.creatingNew && (
                      <div style={{ fontSize: 13, color: "#8A8371", marginBottom: 8 }}>
                        Aucun élève trouvé pour « {booking.query.trim()} ».{" "}
                        <button className="pa-btn" onClick={startCreatingNewFromBooking} style={{ background: "none", color: "#3F6B52", padding: 0, fontSize: 13, textDecoration: "underline" }}>
                          Créer cette fiche élève
                        </button>
                      </div>
                    )}
                    {!booking.query.trim() && <p style={{ fontSize: 12.5, color: "#8A8371" }}>Tapez un nom pour retrouver un élève déjà abonné, ou créez une nouvelle fiche.</p>}

                    {booking.creatingNew && (
                      <div className="pa-card" style={{ padding: 12, marginTop: 8 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: "#1F2A38", marginBottom: 8 }}>Nouvelle fiche élève</div>
                        <input className="pa-input" placeholder="Prénom" value={booking.newPrenom} onChange={(e) => setBooking((b) => ({ ...b, newPrenom: e.target.value }))} style={{ marginBottom: 8 }} />
                        <input className="pa-input" placeholder="Nom" value={booking.newNom} onChange={(e) => setBooking((b) => ({ ...b, newNom: e.target.value }))} style={{ marginBottom: 8 }} />
                        <input className="pa-input" placeholder="Téléphone (optionnel)" value={booking.newPhone} onChange={(e) => setBooking((b) => ({ ...b, newPhone: e.target.value }))} style={{ marginBottom: 8 }} />
                        <input className="pa-input" placeholder="Email (optionnel)" value={booking.newEmail} onChange={(e) => setBooking((b) => ({ ...b, newEmail: e.target.value }))} style={{ marginBottom: 10 }} />
                        <button className="pa-btn" onClick={confirmCreateFromBooking} style={{ background: "#3F6B52", color: "#fff", padding: "8px 14px", fontSize: 13, width: "100%" }}>
                          Créer et sélectionner
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {booking.rosterId && rosterById[booking.rosterId] && (
                  <div className="pa-card" style={{ padding: 12, marginBottom: 16 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                      <div>
                        <div style={{ fontWeight: 600, color: "#1F2A38", fontSize: 15 }}>{rosterById[booking.rosterId].name}</div>
                        <div style={{ fontSize: 12.5, color: "#8A8371", marginTop: 3 }}>
                          {rosterById[booking.rosterId].formula} créneau{rosterById[booking.rosterId].formula > 1 ? "x" : ""}/semaine
                          {rosterById[booking.rosterId].phone ? ` · ${rosterById[booking.rosterId].phone}` : ""}
                        </div>
                        <div style={{ fontSize: 12.5, color: "#6B6455", marginTop: 3 }}>
                          {weeklyCountInWeekOf(booking.rosterId, booking.date || isoDate(monday), booking.assignmentId)}/{rosterById[booking.rosterId].formula} créneau(x) réservé(s) cette semaine
                        </div>
                      </div>
                      <StatusBadge status={rosterById[booking.rosterId].status} />
                    </div>
                    {!booking.assignmentId && (
                      <button className="pa-btn" onClick={() => setBooking((b) => ({ ...b, rosterId: null, query: "" }))} style={{ background: "none", color: "#3F6B52", padding: 0, fontSize: 12.5, textDecoration: "underline", marginTop: 8 }}>
                        Changer d'élève
                      </button>
                    )}
                  </div>
                )}

                {booking.rosterId && (
                  <>
                    <label style={{ fontSize: 13, fontWeight: 600, color: "#6B6455", display: "block", marginBottom: 5 }}>Créneau</label>
                    {booking.assignmentId ? (
                      <div className="pa-card" style={{ padding: "10px 12px", marginBottom: 6, background: "#F5F3ED" }}>
                        <div style={{ fontSize: 14, fontWeight: 600, color: "#1F2A38" }}>
                          {weekdayNameForDate(booking.originalDate)} · {creneauById[booking.originalCreneauId]?.horaire}
                        </div>
                        <div style={{ fontSize: 12, color: "#8A8371", marginTop: 2 }}>
                          Figé jusqu'au renouvellement de l'abonnement — seuls l'activité et le groupe restent modifiables. Pour changer de jour, retirez cette inscription et recréez-en une nouvelle.
                        </div>
                      </div>
                    ) : (
                      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
                        <select className="pa-select" value={booking.date} onChange={(e) => setBooking((b) => ({ ...b, date: e.target.value, creneauId: null }))}>
                          <option value="">Date…</option>
                          {weekDates.map((d) => {
                            const iso = isoDate(d);
                            const dwd = WEEKDAY_NAMES[d.getDay() - 1];
                            const closedEntry = closedByIso[iso];
                            if (closedEntry && iso !== booking.date) return null;
                            return (
                              <option key={iso} value={iso}>
                                {dwd} {shortLabel(d)}{closedEntry ? ` (fermé — ${closedEntry.label})` : ""}
                              </option>
                            );
                          })}
                        </select>
                        <select className="pa-select" value={booking.creneauId || ""} onChange={(e) => setBooking((b) => ({ ...b, creneauId: e.target.value || null }))} disabled={!booking.date}>
                          <option value="">Créneau…</option>
                          {booking.date &&
                            (creneauxByDay[weekdayNameForDate(booking.date)] || []).map((c) => {
                              const occ = countForDate(booking.date, c.id, booking.assignmentId);
                              const disabled = occ >= CAPACITY;
                              return (
                                <option key={c.id} value={c.id} disabled={disabled}>
                                  {c.horaire} — {occ}/{CAPACITY}{disabled ? " (complet)" : ""}
                                </option>
                              );
                            })}
                        </select>
                      </div>
                    )}
                    {!booking.assignmentId && (
                      <p style={{ fontSize: 12, color: "#8A8371", marginTop: -10, marginBottom: 16 }}>
                        Sera réservé sur ce même jour et ce même créneau pendant 4 semaines, sans possibilité de changer avant le renouvellement.
                      </p>
                    )}

                    <label style={{ fontSize: 13, fontWeight: 600, color: "#6B6455", display: "block", marginBottom: 5 }}>Activité prévue</label>
                    <select className="pa-select" value={booking.activite} onChange={(e) => setBooking((b) => ({ ...b, activite: e.target.value }))} style={{ marginBottom: 16 }}>
                      <option value="">Non précisée</option>
                      {ACTIVITES.map((act) => (
                        <option key={act} value={act}>{act}</option>
                      ))}
                    </select>

                    <label style={{ fontSize: 13, fontWeight: 600, color: "#6B6455", display: "block", marginBottom: 5 }}>Groupe de travail</label>
                    <select className="pa-select" value={booking.groupe} onChange={(e) => setBooking((b) => ({ ...b, groupe: e.target.value }))} style={{ marginBottom: 16 }}>
                      <option value="">Non précisé</option>
                      {GROUPES.map((g) => (
                        <option key={g} value={g}>{g}</option>
                      ))}
                    </select>
                  </>
                )}

                {bookingError && <div style={{ background: "#FBEAE4", color: "#B3462F", fontSize: 13, padding: "9px 11px", borderRadius: 7, marginBottom: 14 }}>{bookingError}</div>}

                {booking.assignmentId && deletePanelOpen && (
                  <div className="pa-card" style={{ padding: 12, marginBottom: 14, borderTop: "3px solid #B3462F" }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#1F2A38", marginBottom: 8 }}>Retirer cette réservation</div>
                    {booking.seriesFutureCount > 1 ? (
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        <button className="pa-btn" onClick={removeSingleBooking} style={{ background: "#F5F3ED", color: "#B3462F", padding: "9px 12px", fontSize: 13, textAlign: "left" }}>
                          Seulement ce créneau ({weekdayNameForDate(booking.originalDate)} {shortLabel(new Date(booking.originalDate + "T00:00:00"))})
                        </button>
                        <button className="pa-btn" onClick={removeSeriesFromHere} style={{ background: "#B3462F", color: "#fff", padding: "9px 12px", fontSize: 13, textAlign: "left" }}>
                          Ce créneau et les suivants ({booking.seriesFutureCount} semaines à partir de cette date)
                        </button>
                        <button className="pa-btn" onClick={() => setDeletePanelOpen(false)} style={{ background: "none", color: "#6B6455", padding: 0, fontSize: 12.5, textDecoration: "underline", alignSelf: "flex-start" }}>
                          Annuler
                        </button>
                      </div>
                    ) : (
                      <div style={{ display: "flex", gap: 8 }}>
                        <button className="pa-btn" onClick={removeSingleBooking} style={{ background: "#B3462F", color: "#fff", padding: "9px 14px", fontSize: 13 }}>
                          Confirmer la suppression
                        </button>
                        <button className="pa-btn" onClick={() => setDeletePanelOpen(false)} style={{ background: "#F5F3ED", color: "#1F2A38", padding: "9px 14px", fontSize: 13 }}>
                          Annuler
                        </button>
                      </div>
                    )}
                  </div>
                )}

                <div style={{ display: "flex", gap: 10, justifyContent: "space-between", alignItems: "center", marginTop: 6 }}>
                  {booking.assignmentId && !deletePanelOpen ? (
                    <button className="pa-btn" onClick={() => setDeletePanelOpen(true)} style={{ background: "#F5F3ED", color: "#B3462F", padding: "10px 14px", fontSize: 13 }}>
                      Retirer l'inscription
                    </button>
                  ) : (
                    <span />
                  )}
                  <div style={{ display: "flex", gap: 10 }}>
                    <button className="pa-btn" onClick={closeBooking} style={{ background: "#EFECE2", color: "#1F2A38", padding: "10px 16px", fontSize: 14 }}>
                      Annuler
                    </button>
                    <button
                      className="pa-btn"
                      onClick={booking.assignmentId ? saveEditBooking : saveNewBooking}
                      disabled={!booking.rosterId || !booking.date || !booking.creneauId}
                      style={{ background: "#3F6B52", color: "#fff", padding: "10px 18px", fontSize: 14 }}
                    >
                      Enregistrer
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Roster modal */}
      {rosterModal && (
        <div className="pa-overlay" onClick={closeRosterModal}>
          <div className="pa-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="pa-display" style={{ fontSize: 19, fontWeight: 600, color: "#1F2A38", marginTop: 0 }}>
              {rosterModal.editingId ? "Modifier la fiche élève" : "Nouvel élève"}
            </h3>
            <label style={{ fontSize: 13, fontWeight: 600, color: "#6B6455", display: "block", marginBottom: 5 }}>Prénom</label>
            <input className="pa-input" value={rosterModal.prenom} onChange={(e) => setRosterModal((m) => ({ ...m, prenom: e.target.value }))} style={{ marginBottom: 14 }} />
            <label style={{ fontSize: 13, fontWeight: 600, color: "#6B6455", display: "block", marginBottom: 5 }}>Nom</label>
            <input className="pa-input" value={rosterModal.nom} onChange={(e) => setRosterModal((m) => ({ ...m, nom: e.target.value }))} style={{ marginBottom: 14 }} />
            <label style={{ fontSize: 13, fontWeight: 600, color: "#6B6455", display: "block", marginBottom: 5 }}>Téléphone</label>
            <input className="pa-input" value={rosterModal.phone} onChange={(e) => setRosterModal((m) => ({ ...m, phone: e.target.value }))} style={{ marginBottom: 14 }} />
            <label style={{ fontSize: 13, fontWeight: 600, color: "#6B6455", display: "block", marginBottom: 5 }}>Email</label>
            <input className="pa-input" value={rosterModal.email} onChange={(e) => setRosterModal((m) => ({ ...m, email: e.target.value }))} style={{ marginBottom: 14 }} />

            <label style={{ fontSize: 13, fontWeight: 600, color: "#6B6455", display: "block", marginBottom: 5 }}>Jours d'abonnement</label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14 }}>
              {WEEKDAY_NAMES.map((d) => {
                const active = rosterModal.joursAbonnement.includes(d);
                return (
                  <button
                    key={d}
                    className="pa-btn"
                    onClick={() =>
                      setRosterModal((m) => ({
                        ...m,
                        joursAbonnement: active ? m.joursAbonnement.filter((x) => x !== d) : [...m.joursAbonnement, d],
                      }))
                    }
                    style={{ padding: "7px 11px", fontSize: 12.5, background: active ? "#3F6B52" : "#EFECE2", color: active ? "#fff" : "#1F2A38" }}
                  >
                    {d}
                  </button>
                );
              })}
            </div>

            <label style={{ fontSize: 13, fontWeight: 600, color: "#6B6455", display: "block", marginBottom: 5 }}>Statut</label>
            <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
              {STATUTS.map((s) => (
                <button key={s} className="pa-btn" onClick={() => setRosterModal((m) => ({ ...m, status: s }))} style={{ flex: "1 1 45%", padding: "9px 8px", fontSize: 13, background: rosterModal.status === s ? "#1F2A38" : "#EFECE2", color: rosterModal.status === s ? "#fff" : "#1F2A38" }}>
                  {s}
                </button>
              ))}
            </div>

            {rosterError && <div style={{ background: "#FBEAE4", color: "#B3462F", fontSize: 13, padding: "9px 11px", borderRadius: 7, marginBottom: 14 }}>{rosterError}</div>}

            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button className="pa-btn" onClick={closeRosterModal} style={{ background: "#EFECE2", color: "#1F2A38", padding: "10px 16px", fontSize: 14 }}>
                Annuler
              </button>
              <button className="pa-btn" onClick={saveRosterModal} style={{ background: "#3F6B52", color: "#fff", padding: "10px 18px", fontSize: 14 }}>
                Enregistrer
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Account modal */}
      {accountModal && (
        <div className="pa-overlay" onClick={closeAccountModal}>
          <div className="pa-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="pa-display" style={{ fontSize: 19, fontWeight: 600, color: "#1F2A38", marginTop: 0 }}>
              {accountModal.editingId ? "Modifier le compte" : "Nouveau compte"}
            </h3>
            <label style={{ fontSize: 13, fontWeight: 600, color: "#6B6455", display: "block", marginBottom: 5 }}>Nom</label>
            <input className="pa-input" value={accountModal.name} onChange={(e) => setAccountModal((m) => ({ ...m, name: e.target.value }))} style={{ marginBottom: 14 }} autoFocus />

            <label style={{ fontSize: 13, fontWeight: 600, color: "#6B6455", display: "block", marginBottom: 5 }}>Rôle</label>
            <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
              {["Admin", "Animateur"].map((r) => (
                <button
                  key={r}
                  className="pa-btn"
                  onClick={() => setAccountModal((m) => ({ ...m, role: r }))}
                  style={{ flex: 1, padding: "10px 8px", fontSize: 13.5, background: accountModal.role === r ? "#3F6B52" : "#EFECE2", color: accountModal.role === r ? "#fff" : "#1F2A38" }}
                >
                  {r}
                </button>
              ))}
            </div>

            {accountError && <div style={{ background: "#FBEAE4", color: "#B3462F", fontSize: 13, padding: "9px 11px", borderRadius: 7, marginBottom: 14 }}>{accountError}</div>}

            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button className="pa-btn" onClick={closeAccountModal} style={{ background: "#EFECE2", color: "#1F2A38", padding: "10px 16px", fontSize: 14 }}>
                Annuler
              </button>
              <button className="pa-btn" onClick={saveAccountModal} style={{ background: "#3F6B52", color: "#fff", padding: "10px 18px", fontSize: 14 }}>
                Enregistrer
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Settings modal — gestion des créneaux (Airtable, en direct) */}
      {settingsOpen && (
        <div className="pa-overlay" onClick={() => setSettingsOpen(false)}>
          <div className="pa-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="pa-display" style={{ fontSize: 19, fontWeight: 600, color: "#1F2A38", marginTop: 0 }}>Gérer les créneaux</h3>
            <p style={{ fontSize: 13, color: "#8A8371", marginTop: -6, marginBottom: 16 }}>
              Chaque modification est enregistrée immédiatement dans Airtable. Renommez un horaire en cliquant hors du champ, ajoutez ou retirez un créneau par jour.
            </p>
            {WEEKDAY_NAMES.map((day) => (
              <div key={day} style={{ marginBottom: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: "#1F2A38" }}>{day}</div>
                  <button className="pa-btn" onClick={() => addCreneau(day)} style={{ background: "#EFECE2", color: "#3F6B52", padding: "4px 9px", fontSize: 12 }}>
                    + Ajouter
                  </button>
                </div>
                {creneauError[day] && (
                  <div style={{ background: "#FBEAE4", color: "#B3462F", fontSize: 12, padding: "6px 9px", borderRadius: 6, marginBottom: 6 }}>
                    {creneauError[day]}
                  </div>
                )}
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {(creneauxByDay[day] || []).map((c) => (
                    <div key={c.id} style={{ display: "flex", gap: 6 }}>
                      <input
                        className="pa-input"
                        defaultValue={c.horaire}
                        onBlur={(e) => {
                          const val = e.target.value.trim();
                          if (val && val !== c.horaire) renameCreneau(c.id, val);
                        }}
                      />
                      <button className="pa-btn" onClick={() => removeCreneau(day, c.id)} style={{ background: "#F5F3ED", color: "#B3462F", padding: "8px 10px", fontSize: 12, whiteSpace: "nowrap" }}>
                        − Retirer
                      </button>
                    </div>
                  ))}
                  {(creneauxByDay[day] || []).length === 0 && <p style={{ fontSize: 12.5, color: "#8A8371", margin: 0 }}>Aucun créneau ce jour-là.</p>}
                </div>
              </div>
            ))}
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
              <button className="pa-btn" onClick={() => setSettingsOpen(false)} style={{ background: "#3F6B52", color: "#fff", padding: "10px 18px", fontSize: 14 }}>
                Fermer
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<App />);