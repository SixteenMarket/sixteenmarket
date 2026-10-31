/* SixteenMarket — application (v3, 2026-10-31)
   Une seule page, plusieurs écrans, navigation par adresse (#/apps, #/app/…, #/compte…). */
(function () {
  'use strict';

  /* Protection contre l'affichage du site dans le cadre d'un autre site (clickjacking).
     GitHub Pages ne permet pas d'envoyer l'en-tête X-Frame-Options, on le fait ici. */
  if (window.top !== window.self) {
    try { window.top.location = window.self.location.href; }
    catch (e) { document.documentElement.style.display = 'none'; }
    return;
  }

  /* ------------------------------------------------------------------ */
  /* Configuration                                                       */
  /* ------------------------------------------------------------------ */
  var SUPABASE_URL = 'https://txbvpddpsejtfjvixdfw.supabase.co';
  var SUPABASE_KEY = 'sb_publishable_DzvshGmn8ev43bDoPlpnkQ_BIMINTsR'; // clé publique : sa protection repose sur les règles RLS (voir supabase/securite.sql)
  var BUCKET = 'app-media';
  var TERMS_VERSION = '2026-10-31';
  var REMEMBER_LOGIN = false;       // false : la connexion est oubliée à la fermeture de l'onglet. true : elle est mémorisée.
  var MIN_PASSWORD = 10;
  var MAX_IMAGE = 5 * 1024 * 1024;
  var MAX_APP_FILE = 50 * 1024 * 1024;
  var IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
  var MAX_MESSAGE = 500;
  var COOLDOWN_SECONDS = 60;
  var SITE_URL = location.origin + location.pathname.replace(/index\.html$/, '');
  var MEDIA_PREFIX = SUPABASE_URL + '/storage/v1/object/public/';

  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var pointerFine = window.matchMedia && window.matchMedia('(pointer: fine)').matches;

  /* Lien reçu par email (confirmation, récupération) : on lit l'adresse avant que Supabase ne la traite. */
  var initialHash = location.hash || '';
  var linkError = null;
  if (initialHash.indexOf('#/') !== 0 && /[#&]error(_code|_description)?=/.test(initialHash)) {
    try {
      var hp = new URLSearchParams(initialHash.slice(1));
      linkError = hp.get('error_code') || hp.get('error') || 'error';
    } catch (e) { linkError = 'error'; }
    history.replaceState(null, '', location.pathname + location.search);
    initialHash = '';
  }
  var justConfirmed = /[#&]type=signup/.test(initialHash);

  function $(id) { return document.getElementById(id); }

  function safeStorage(kind) {
    try { var s = window[kind]; s.setItem('__sm', '1'); s.removeItem('__sm'); return s; }
    catch (e) { return null; }
  }
  var authStorage = safeStorage(REMEMBER_LOGIN ? 'localStorage' : 'sessionStorage');

  var sb = null;
  if (window.supabase && window.supabase.createClient) {
    sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: {
        persistSession: !!authStorage,
        storage: authStorage || undefined,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        flowType: 'implicit'
      }
    });
  }

  var state = {
    authReady: false, loggedIn: false, userId: null, isAdmin: false, pseudo: '', email: '',
    recovery: false, next: null,
    apps: [], appsLoaded: false, appsError: false,
    messages: [], bans: [],
    editingId: null,
    authMode: 'login'
  };

  /* ------------------------------------------------------------------ */
  /* Utilitaires                                                         */
  /* ------------------------------------------------------------------ */
  function escapeHtml(str) {
    return String(str === null || str === undefined ? '' : str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* Seules les adresses de fichiers de notre propre stockage sont acceptées. */
  function safeMediaUrl(u) {
    return (typeof u === 'string' && u.indexOf(MEDIA_PREFIX) === 0) ? u : '';
  }
  function storagePathFromUrl(u) {
    var prefix = MEDIA_PREFIX + BUCKET + '/';
    if (typeof u !== 'string' || u.indexOf(prefix) !== 0) return null;
    try { return decodeURIComponent(u.slice(prefix.length)); } catch (e) { return null; }
  }

  function plural(n, one, many) { return n + ' ' + (n > 1 ? many : one); }

  function formatDate(iso, withTime) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var opts = withTime
      ? { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }
      : { day: 'numeric', month: 'long', year: 'numeric' };
    return d.toLocaleString('fr-FR', opts);
  }
  function formatTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var now = new Date();
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    return formatDate(iso, true);
  }
  function formatSize(bytes) {
    if (bytes >= 1048576) return (bytes / 1048576).toFixed(1).replace('.', ',').replace(',0', '') + ' Mo';
    return Math.max(1, Math.round(bytes / 1024)) + ' Ko';
  }

  function setNote(el, text, kind) {
    el.className = 'form-note' + (kind ? ' ' + kind : '');
    el.textContent = text || '';
  }
  function setBusy(btn, busy, label) {
    if (!btn) return;
    if (busy) { btn.dataset.label = btn.textContent; btn.textContent = label || 'Un instant…'; btn.disabled = true; }
    else { if (btn.dataset.label) btn.textContent = btn.dataset.label; btn.disabled = false; }
  }

  function toast(message, kind) {
    var box = $('toasts');
    var t = document.createElement('div');
    t.className = 'toast' + (kind ? ' ' + kind : '');
    t.textContent = message;
    box.appendChild(t);
    setTimeout(function () { t.remove(); }, kind === 'error' ? 7000 : 4500);
  }

  function confirmDialog(message, okLabel) {
    return new Promise(function (resolve) {
      var d = $('confirmDialog');
      if (!d || typeof d.showModal !== 'function') { resolve(window.confirm(message)); return; }
      $('confirmMsg').textContent = message;
      $('confirmOk').textContent = okLabel || 'Confirmer';
      d.returnValue = '';
      var onClose = function () { d.removeEventListener('close', onClose); resolve(d.returnValue === 'ok'); };
      d.addEventListener('close', onClose);
      d.showModal();
    });
  }

  /* Messages d'erreur en français (on ne montre jamais le texte anglais brut). */
  function frError(err) {
    if (!err) return 'Une erreur est survenue. Réessaie dans un instant.';
    var code = err.code || '';
    var msg = String(err.message || err);
    var byCode = {
      invalid_credentials: 'Email ou mot de passe incorrect.',
      email_not_confirmed: 'Ton email n’est pas encore confirmé. Vérifie ta boîte mail (et les spams).',
      user_already_exists: 'Un compte existe déjà avec cet email. Essaie de te connecter.',
      email_exists: 'Un compte existe déjà avec cet email. Essaie de te connecter.',
      weak_password: 'Ce mot de passe est trop faible. Choisis-en un plus long et plus varié.',
      same_password: 'Le nouveau mot de passe doit être différent de l’ancien.',
      over_request_rate_limit: 'Trop de tentatives. Attends quelques minutes puis réessaie.',
      over_email_send_rate_limit: 'Trop d’emails envoyés. Attends quelques minutes puis réessaie.',
      signup_disabled: 'Les inscriptions sont fermées pour le moment.',
      user_banned: 'Ce compte est suspendu.',
      validation_failed: 'Les informations saisies ne sont pas valides.',
      otp_expired: 'Ce lien a expiré ou a déjà été utilisé. Demande-en un nouveau.',
      session_not_found: 'Ta session a expiré. Reconnecte-toi.',
      session_expired: 'Ta session a expiré. Reconnecte-toi.',
      refresh_token_not_found: 'Ta session a expiré. Reconnecte-toi.'
    };
    if (byCode[code]) return byCode[code];
    var rules = [
      [/sm_banned/, 'Tu ne peux plus écrire dans la salle de discussion.'],
      [/sm_rate_limit/, 'Doucement ! Attends quelques secondes entre deux messages.'],
      [/sm_too_long/, 'Ton message est trop long (500 caractères maximum).'],
      [/sm_empty/, 'Ton message est vide.'],
      [/sm_admin_protected/, 'Le compte administrateur ne peut pas être supprimé ici.'],
      [/sm_auth|JWT|not authenticated/i, 'Ta session a expiré. Reconnecte-toi.'],
      [/invalid login credentials/i, 'Email ou mot de passe incorrect.'],
      [/email not confirmed/i, 'Ton email n’est pas encore confirmé. Vérifie ta boîte mail (et les spams).'],
      [/already registered|already been registered/i, 'Un compte existe déjà avec cet email. Essaie de te connecter.'],
      [/only request this once|rate limit/i, 'Trop de demandes. Attends une minute puis réessaie.'],
      [/same password|different from the old/i, 'Le nouveau mot de passe doit être différent de l’ancien.'],
      [/password should be|weak/i, 'Ce mot de passe est trop faible. Choisis-en un plus long et plus varié.'],
      [/row-level security|permission denied|violates/i, 'Action non autorisée.'],
      [/failed to fetch|networkerror|load failed|network request failed/i, 'Connexion impossible. Vérifie ta connexion internet puis réessaie.']
    ];
    for (var i = 0; i < rules.length; i++) { if (rules[i][0].test(msg)) return rules[i][1]; }
    if (window.console) console.error(err);
    return 'Une erreur est survenue. Réessaie dans un instant.';
  }

  /* ------------------------------------------------------------------ */
  /* Mots de passe                                                       */
  /* ------------------------------------------------------------------ */
  var COMMON = ['password', 'motdepasse', 'azerty', 'qwerty', '123456', '111111', '000000', 'admin', 'letmein',
    'welcome', 'iloveyou', 'sixteen', 'bonjour', 'soleil', 'football', 'dragon', 'abc123', 'passw0rd'];

  function passwordInfo(pw, email) {
    var hasLen = pw.length >= MIN_PASSWORD;
    var hasUpper = /[A-Z]/.test(pw), hasLower = /[a-z]/.test(pw), hasNum = /[0-9]/.test(pw);
    var hasSpecial = /[^A-Za-z0-9]/.test(pw);
    var lower = pw.toLowerCase();
    var local = String(email || '').split('@')[0].toLowerCase();
    var common = pw.length < 16 && COMMON.some(function (w) { return lower.indexOf(w) > -1; });
    var hasEmailPart = local.length >= 4 && lower.indexOf(local) > -1;
    var repeated = /^(.)\1+$/.test(pw);
    var label = '', cls = '', valid = false;
    if (!pw) { label = ''; }
    else if (!hasLen) { label = 'Trop court — au moins ' + MIN_PASSWORD + ' caractères.'; cls = 'weak'; }
    else if (!(hasUpper && hasLower && hasNum)) { label = 'Ajoute une majuscule, une minuscule et un chiffre.'; cls = 'weak'; }
    else if (common || hasEmailPart || repeated) { label = 'Trop courant ou trop proche de ton email — choisis-en un autre.'; cls = 'weak'; }
    else if (hasSpecial || pw.length >= 14) { label = 'Mot de passe fort.'; cls = 'strong'; valid = true; }
    else { label = 'Correct. Un symbole ou quelques caractères de plus le renforceraient.'; cls = 'medium'; valid = true; }
    return { valid: valid, label: label, cls: cls };
  }
  function wireStrength(inputId, outId, emailGetter) {
    var input = $(inputId), out = $(outId);
    input.addEventListener('input', function () {
      var info = passwordInfo(input.value, emailGetter ? emailGetter() : '');
      out.textContent = info.label;
      out.className = 'pw-strength' + (info.cls ? ' ' + info.cls : '');
    });
  }
  var PW_HELP = 'Choisis un mot de passe d’au moins ' + MIN_PASSWORD + ' caractères avec majuscule, minuscule et chiffre.';

  var PSEUDO_RE;
  try { PSEUDO_RE = new RegExp('^[\\p{L}\\p{N}][\\p{L}\\p{N} _.\'’\\-]{1,23}$', 'u'); }
  catch (e) { PSEUDO_RE = /^[A-Za-z0-9À-ÿ][A-Za-z0-9À-ÿ _.'’\-]{1,23}$/; }
  var PSEUDO_HELP = 'Le pseudo doit faire 2 à 24 caractères (lettres, chiffres, espaces, . _ - ’).';

  /* ------------------------------------------------------------------ */
  /* Transition « coup de pinceau »                                      */
  /* ------------------------------------------------------------------ */
  var overlay = $('pageTransition');
  var overlaySvg = overlay.querySelector('svg');
  var overlayPath = overlay.querySelector('path');
  var transitionBusy = false;

  function playTransition(color, onMid) {
    if (reduce || transitionBusy) { onMid(); return; }
    transitionBusy = true;
    overlayPath.style.fill = color;
    overlay.style.transition = 'opacity .1s linear';
    overlay.style.opacity = '1';
    overlaySvg.style.transition = 'transform .45s cubic-bezier(.5,0,.25,1)';
    overlaySvg.style.transform = 'translateX(0%)';
    setTimeout(function () {
      onMid();
      overlay.style.transition = 'opacity .4s ease';
      overlay.style.opacity = '0';
      setTimeout(function () {
        overlaySvg.style.transition = 'none';
        overlaySvg.style.transform = 'translateX(-115%)';
        transitionBusy = false;
      }, 420);
    }, 450);
  }

  /* ------------------------------------------------------------------ */
  /* Écrans et navigation                                                */
  /* ------------------------------------------------------------------ */
  var PLAIN_SCREENS = { apps: 1, communaute: 1, compte: 1, connexion: 1, 'mot-de-passe-oublie': 1, 'nouveau-mot-de-passe': 1, admin: 1 };
  var NEEDS_LOGIN = { communaute: 1, compte: 1, admin: 1 };
  var AUTH_DEPENDENT = { communaute: 1, compte: 1, admin: 1, connexion: 1, 'mot-de-passe-oublie': 1, 'nouveau-mot-de-passe': 1 };
  var ACCENTS = {
    accueil: 'var(--turquoise-deep)', apps: 'var(--turquoise-deep)', fiche: 'var(--turquoise-deep)',
    communaute: 'var(--coral-deep)', compte: 'var(--violet-deep)', connexion: 'var(--amber-deep)',
    'mot-de-passe-oublie': 'var(--amber-deep)', 'nouveau-mot-de-passe': 'var(--amber-deep)', admin: 'var(--ink)'
  };
  var TITLES = {
    accueil: 'SixteenMarket – Catalogue d’applications à télécharger et communauté',
    apps: 'Apps – SixteenMarket', communaute: 'Communauté – SixteenMarket', compte: 'Mon compte – SixteenMarket',
    connexion: 'Connexion – SixteenMarket', 'mot-de-passe-oublie': 'Mot de passe oublié – SixteenMarket',
    'nouveau-mot-de-passe': 'Nouveau mot de passe – SixteenMarket', admin: 'Admin – SixteenMarket'
  };

  var currentScreen = 'accueil';
  var firstRender = true;
  var swapToken = 0;

  function parseRoute() {
    var h = location.hash || '';
    if (h.indexOf('#/') !== 0) return { name: 'accueil' };
    var seg = h.slice(2).split('?')[0].replace(/\/+$/, '').split('/');
    if (!seg[0]) return { name: 'accueil' };
    if (seg[0] === 'app' && seg[1]) {
      var id = seg[1];
      try { id = decodeURIComponent(seg[1]); } catch (e) { /* garde la valeur brute */ }
      return { name: 'fiche', id: id };
    }
    if (PLAIN_SCREENS[seg[0]]) return { name: seg[0] };
    return { name: 'accueil' };
  }

  function go(path, replace) {
    var target = '#' + path;
    if (replace) {
      history.replaceState(null, '', location.pathname + location.search + target);
      renderRoute(true);
    } else if (location.hash === target) {
      renderRoute(true);
    } else {
      location.hash = target;
    }
  }

  function showScreen(name, after, reRender) {
    var token = ++swapToken;
    var changed = name !== currentScreen;
    var apply = function () {
      if (token !== swapToken) return;
      if (changed) {
        var screens = document.querySelectorAll('.screen');
        for (var i = 0; i < screens.length; i++) screens[i].classList.remove('active');
        $('screen-' + name).classList.add('active');
        currentScreen = name;
        window.scrollTo(0, 0);
      }
      var navName = name === 'fiche' ? 'apps' : name;
      var links = document.querySelectorAll('[data-nav]');
      for (var j = 0; j < links.length; j++) {
        var on = links[j].getAttribute('data-nav') === navName;
        links[j].classList.toggle('active', on);
        if (on) links[j].setAttribute('aria-current', 'page'); else links[j].removeAttribute('aria-current');
      }
      if (TITLES[name]) document.title = TITLES[name];
      if (after && (changed || reRender)) after();
      if (changed && !firstRender) {
        var heading = document.querySelector('#screen-' + name + ' [tabindex="-1"]');
        if (heading) heading.focus({ preventScroll: true });
      }
      firstRender = false;
    };
    if (!changed || firstRender) apply();
    else playTransition(ACCENTS[name] || 'var(--coral-deep)', apply);
  }

  function renderRoute(reRender) {
    var route = parseRoute();
    var name = route.name;

    if (!state.authReady && AUTH_DEPENDENT[name]) return; // on attend de savoir si la personne est connectée

    if (NEEDS_LOGIN[name] && !state.loggedIn) {
      state.next = '/' + name;
      go('/connexion', true);
      return;
    }
    if (name === 'admin' && !state.isAdmin) {
      toast('Cet espace est réservé à l’administrateur.', 'error');
      go('/', true);
      return;
    }
    if ((name === 'connexion' || name === 'mot-de-passe-oublie') && state.loggedIn && !state.recovery) {
      go('/compte', true);
      return;
    }
    if (name === 'nouveau-mot-de-passe' && !state.recovery) {
      go(state.loggedIn ? '/compte' : '/mot-de-passe-oublie', true);
      return;
    }
    showScreen(name, function () { if (RENDER[name]) RENDER[name](route); }, reRender);
  }

  var RENDER = {
    accueil: function () { renderLatest(); },
    apps: function () { renderApps(); },
    fiche: function (route) { renderFiche(route.id); },
    communaute: function () { renderChat(true); },
    compte: function () {
      $('settingsEmail').textContent = state.email;
      $('settingsPseudo').value = state.pseudo;
      setNote($('settingsNote'), '');
    },
    connexion: function () {
      setAuthMode(state.authMode);
    },
    'mot-de-passe-oublie': function () { setNote($('forgotNote'), ''); },
    'nouveau-mot-de-passe': function () { setNote($('recoveryNote'), ''); },
    admin: function () { renderAdmin(); loadBans(); }
  };

  window.addEventListener('hashchange', function () { renderRoute(true); });

  /* ------------------------------------------------------------------ */
  /* Catalogue d'apps                                                    */
  /* ------------------------------------------------------------------ */
  function findApp(id) {
    for (var i = 0; i < state.apps.length; i++) if (String(state.apps[i].id) === String(id)) return state.apps[i];
    return null;
  }

  function tileHtml(a, i, level) {
    level = level || 2;
    var icon = safeMediaUrl(a.icon_url);
    var iconHtml = icon
      ? '<span class="app-icon"><img src="' + escapeHtml(icon) + '" alt="" width="58" height="58" loading="lazy" decoding="async"></span>'
      : '<span class="app-icon g' + (i % 5) + '"></span>';
    return '<a class="app-tile" href="#/app/' + encodeURIComponent(a.id) + '">' + iconHtml +
      '<div class="app-info"><h' + level + '>' + escapeHtml(a.name) + '</h' + level + '><p>' + escapeHtml(a.description) + '</p></div></a>';
  }

  function loadApps() {
    if (!sb) { state.appsError = true; afterAppsChange(); return Promise.resolve(); }
    state.appsLoaded = false; state.appsError = false;
    afterAppsChange();
    return Promise.all([
      sb.from('apps').select('*').order('created_at', { ascending: false }),
      sb.from('app_screenshots').select('*').order('position', { ascending: true })
    ]).then(function (r) {
      if (r[0].error) throw r[0].error;
      var apps = r[0].data || [];
      var shots = (r[1] && r[1].data) || [];
      apps.forEach(function (a) {
        a.screenshots = shots.filter(function (s) { return s.app_id === a.id; });
        a.downloads = Number(a.downloads) || 0;
      });
      state.apps = apps;
      state.appsLoaded = true;
      state.appsError = false;
      afterAppsChange();
    }).catch(function (err) {
      console.error(err);
      state.appsLoaded = false;
      state.appsError = true;
      afterAppsChange();
    });
  }
  function afterAppsChange() {
    renderApps();
    renderLatest();
    if (currentScreen === 'fiche') renderFiche(parseRoute().id);
    if (state.isAdmin) renderAdmin();
  }

  function renderApps() {
    var grid = $('appsGrid');
    if (state.appsError) {
      grid.innerHTML = '<div class="empty-note">Impossible de charger les apps pour le moment. <button type="button" class="link-btn" data-retry-apps>Réessayer</button></div>';
      return;
    }
    if (!state.appsLoaded) { grid.innerHTML = '<p class="empty-note">Chargement des apps…</p>'; return; }
    var q = ($('appSearch').value || '').trim().toLowerCase();
    var list = state.apps.filter(function (a) {
      return !q || a.name.toLowerCase().indexOf(q) > -1 || (a.description || '').toLowerCase().indexOf(q) > -1;
    });
    if (!state.apps.length) { grid.innerHTML = '<p class="empty-note">Aucune app n’est publiée pour l’instant.</p>'; return; }
    if (!list.length) { grid.innerHTML = '<p class="empty-note">Aucune app ne correspond à cette recherche.</p>'; return; }
    grid.innerHTML = list.map(function (a) { return tileHtml(a, state.apps.indexOf(a), 2); }).join('');
  }

  function renderLatest() {
    var box = $('latestApps');
    if (!state.appsLoaded || !state.apps.length) { box.hidden = true; return; }
    box.hidden = false;
    $('latestGrid').innerHTML = state.apps.slice(0, 3).map(function (a, i) { return tileHtml(a, i, 3); }).join('');
  }

  $('appSearch').addEventListener('input', renderApps);
  $('appsGrid').addEventListener('click', function (e) {
    if (e.target.closest('[data-retry-apps]')) loadApps();
  });

  /* ------------------------------------------------------------------ */
  /* Fiche d'une app                                                     */
  /* ------------------------------------------------------------------ */
  var currentFicheApp = null;
  var currentShot = 0;
  var countedDownloads = {};
  try { countedDownloads = JSON.parse(sessionStorage.getItem('sm_dl') || '{}') || {}; } catch (e) { countedDownloads = {}; }

  function renderFiche(id) {
    var box = $('ficheContent');
    currentFicheApp = null;
    if (!state.appsLoaded && !state.appsError) { box.innerHTML = '<p>Chargement…</p>'; return; }
    var app = findApp(id);
    if (!app) {
      box.innerHTML = '<h1 id="t-fiche" tabindex="-1">App introuvable</h1><p class="fiche-desc">Cette app n’existe plus ou le lien est incorrect.</p><a class="dl-btn" href="#/apps">Voir toutes les apps</a>';
      document.title = 'App introuvable – SixteenMarket';
      return;
    }
    currentFicheApp = app;
    currentShot = 0;
    var file = safeMediaUrl(app.file_url);
    var dl = file
      ? '<a class="dl-btn" id="ficheDlBtn" href="' + escapeHtml(file) + '" download rel="noopener" data-app-id="' + escapeHtml(app.id) + '">Télécharger</a>'
      : '<span class="dl-btn is-off">Fichier indisponible</span>';
    var added = app.created_at ? formatDate(app.created_at, false) : '';
    box.innerHTML =
      '<div class="ss-viewer"><div class="ss-main" id="ssMain"></div>' +
        '<button type="button" class="ss-nav ss-prev" id="ssPrev" aria-label="Capture précédente" hidden>‹</button>' +
        '<button type="button" class="ss-nav ss-next" id="ssNext" aria-label="Capture suivante" hidden>›</button>' +
      '</div>' +
      '<div class="ss-dots" id="ssDots" hidden></div>' +
      '<h1 id="t-fiche" tabindex="-1">' + escapeHtml(app.name) + '</h1>' +
      '<p class="fiche-desc">' + escapeHtml(app.description) + '</p>' +
      '<div class="meta-row"><span>v' + escapeHtml(app.version) + '</span><span>' + escapeHtml(app.size) + '</span><span>' + escapeHtml(app.format) + '</span></div>' +
      '<div class="dl-row spaced">' + dl +
        '<span class="dl-count"><span id="ficheDlCount">' + app.downloads + '</span> ' + (app.downloads > 1 ? 'téléchargements' : 'téléchargement') + '</span></div>' +
      '<div class="fiche-actions"><button type="button" class="ghost-btn" id="ficheShare">Partager</button></div>' +
      (added ? '<p class="fiche-date">Ajoutée le ' + escapeHtml(added) + '</p>' : '');
    document.title = app.name + ' – SixteenMarket';
    renderFicheViewer();
  }

  function renderFicheViewer() {
    var app = currentFicheApp;
    if (!app) return;
    var shots = (app.screenshots || []).filter(function (s) { return safeMediaUrl(s.url); });
    var holder = $('ssMain');
    if (!holder) return;
    var url = shots.length ? safeMediaUrl(shots[currentShot].url) : safeMediaUrl(app.icon_url);
    var el;
    if (url) {
      el = document.createElement('img');
      el.src = url;
      el.alt = shots.length ? 'Capture d’écran ' + (currentShot + 1) + ' sur ' + shots.length + ' de ' + app.name : 'Icône de ' + app.name;
      el.decoding = 'async';
    } else {
      el = document.createElement('div');
      el.className = 'g' + (state.apps.indexOf(app) % 5);
      el.setAttribute('role', 'img');
      el.setAttribute('aria-label', 'Illustration de ' + app.name);
    }
    el.id = 'ssMain';
    el.classList.add('ss-main');
    holder.replaceWith(el);
    var nav = shots.length > 1;
    $('ssPrev').hidden = !nav;
    $('ssNext').hidden = !nav;
    var dots = $('ssDots');
    dots.hidden = !nav;
    dots.innerHTML = nav ? shots.map(function (s, i) {
      return '<button type="button" class="ss-dot' + (i === currentShot ? ' active' : '') + '" data-idx="' + i + '" aria-label="Capture ' + (i + 1) + '"></button>';
    }).join('') : '';
  }

  function shareApp(app) {
    var url = SITE_URL + '#/app/' + encodeURIComponent(app.id);
    if (navigator.share) {
      navigator.share({ title: app.name + ' – SixteenMarket', text: app.description, url: url }).catch(function () { /* annulé */ });
    } else if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function () { toast('Lien copié.', 'ok'); }, function () { toast(url); });
    } else {
      toast(url);
    }
  }

  $('ficheContent').addEventListener('click', function (e) {
    var app = currentFicheApp;
    if (!app) return;
    var shots = (app.screenshots || []).filter(function (s) { return safeMediaUrl(s.url); });
    if (e.target.closest('#ssPrev') || e.target.closest('#ssNext')) {
      if (shots.length) {
        currentShot = e.target.closest('#ssPrev')
          ? (currentShot - 1 + shots.length) % shots.length
          : (currentShot + 1) % shots.length;
        renderFicheViewer();
      }
      return;
    }
    var dot = e.target.closest('.ss-dot');
    if (dot) { currentShot = parseInt(dot.getAttribute('data-idx'), 10) || 0; renderFicheViewer(); return; }
    if (e.target.closest('#ficheShare')) { shareApp(app); return; }
    var dlBtn = e.target.closest('#ficheDlBtn');
    if (dlBtn) {
      confettiBurst(dlBtn);
      var key = String(app.id);
      if (countedDownloads[key] || !sb) return; // une seule comptabilisation par app et par visite
      countedDownloads[key] = 1;
      try { sessionStorage.setItem('sm_dl', JSON.stringify(countedDownloads)); } catch (err) { /* ignoré */ }
      app.downloads = (app.downloads || 0) + 1;
      var countEl = $('ficheDlCount');
      if (countEl) countEl.textContent = app.downloads;
      sb.rpc('increment_downloads', { app_id: app.id }).then(function (res) {
        if (res.error) {
          console.error(res.error);
          app.downloads = Math.max((app.downloads || 1) - 1, 0);
          delete countedDownloads[key];
          if (countEl) countEl.textContent = app.downloads;
        }
      });
    }
  });

  /* ------------------------------------------------------------------ */
  /* Salle de discussion                                                 */
  /* ------------------------------------------------------------------ */
  var MSG_COLUMNS = 'id,user_id,author,text,created_at,is_admin';
  var channel = null;
  var sending = false;

  function cleanMessage(m) {
    return { id: m.id, user_id: m.user_id || null, author: m.author || 'Membre', text: m.text || '', created_at: m.created_at, is_admin: !!m.is_admin };
  }
  function loadMessages() {
    if (!sb || !state.loggedIn) return;
    sb.from('messages').select(MSG_COLUMNS).order('created_at', { ascending: false }).limit(200).then(function (res) {
      if (res.error) { console.error(res.error); return; }
      state.messages = (res.data || []).map(cleanMessage).reverse();
      renderChat(true);
      if (state.isAdmin) renderAdmin();
    });
  }
  function addMessage(m) {
    m = cleanMessage(m);
    for (var i = 0; i < state.messages.length; i++) if (String(state.messages[i].id) === String(m.id)) return;
    state.messages.push(m);
    renderChat(false);
    if (state.isAdmin) renderAdmin();
  }
  function removeMessage(id) {
    state.messages = state.messages.filter(function (m) { return String(m.id) !== String(id); });
    renderChat(false);
    if (state.isAdmin) renderAdmin();
  }
  function startRealtime() {
    if (!sb || channel) return;
    channel = sb.channel('public:messages')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, function (p) { addMessage(p.new); })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'messages' }, function (p) { removeMessage(p.old.id); })
      .subscribe();
  }
  function stopRealtime() {
    if (sb && channel) { sb.removeChannel(channel); }
    channel = null;
  }

  function renderChat(forceBottom) {
    var box = $('chatMessages');
    if (!box) return;
    var nearBottom = forceBottom || (box.scrollHeight - box.scrollTop - box.clientHeight < 80);
    if (!state.messages.length) {
      box.innerHTML = '<p class="chat-empty">Aucun message pour l’instant. Écris le premier !</p>';
      return;
    }
    box.innerHTML = state.messages.map(function (m) {
      var mine = m.user_id && m.user_id === state.userId;
      var canDelete = mine || state.isAdmin;
      return '<div class="chat-bubble' + (mine ? ' mine' : '') + '">' +
        '<div class="chat-head"><strong>' + escapeHtml(m.author) + '</strong>' +
        (m.is_admin ? '<span class="badge">Admin</span>' : '') +
        '<time datetime="' + escapeHtml(m.created_at) + '">' + escapeHtml(formatTime(m.created_at)) + '</time>' +
        (canDelete ? '<button type="button" class="chat-del" data-del-chat="' + escapeHtml(m.id) + '">Supprimer</button>' : '') +
        '</div><span class="chat-text">' + escapeHtml(m.text) + '</span></div>';
    }).join('');
    if (nearBottom) box.scrollTop = box.scrollHeight;
  }

  $('chatMessages').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-del-chat]');
    if (!btn) return;
    deleteMessage(btn.getAttribute('data-del-chat'));
  });
  function deleteMessage(id, silent) {
    var ask = silent ? Promise.resolve(true) : confirmDialog('Supprimer ce message ?', 'Supprimer');
    return ask.then(function (ok) {
      if (!ok) return;
      return sb.from('messages').delete().eq('id', id).then(function (res) {
        if (res.error) { toast(frError(res.error), 'error'); return; }
        removeMessage(id);
      });
    });
  }

  function updateChatCount() {
    var n = $('chatInput').value.length;
    $('chatCount').textContent = n + ' / ' + MAX_MESSAGE;
  }
  $('chatInput').addEventListener('input', updateChatCount);
  $('chatForm').addEventListener('submit', function (e) {
    e.preventDefault();
    if (sending || !sb || !state.loggedIn) return;
    var input = $('chatInput');
    var text = input.value.trim();
    if (!text) return;
    sending = true;
    $('chatSend').disabled = true;
    sb.from('messages').insert({ text: text }).select(MSG_COLUMNS).single().then(function (res) {
      sending = false;
      $('chatSend').disabled = false;
      if (res.error) { toast(frError(res.error), 'error'); return; }
      input.value = '';
      updateChatCount();
      if (res.data) { addMessage(res.data); $('chatMessages').scrollTop = $('chatMessages').scrollHeight; }
    });
  });

  /* ------------------------------------------------------------------ */
  /* Session                                                             */
  /* ------------------------------------------------------------------ */
  function updateNav() {
    $('authNavLink').hidden = state.loggedIn;
    $('navUser').hidden = !state.loggedIn;
    $('navUserPseudo').textContent = state.pseudo;
    $('adminNavLink').hidden = !state.isAdmin;
  }

  function applyUser(user) {
    var changed = state.userId !== user.id;
    var meta = user.user_metadata || {};
    state.loggedIn = true;
    state.userId = user.id;
    state.email = user.email || '';
    state.pseudo = meta.pseudo || (user.email || 'membre').split('@')[0];
    state.isAdmin = !!(user.app_metadata && user.app_metadata.role === 'admin'); // rôle posé côté serveur, non modifiable par l'utilisateur
    updateNav();
    if (changed) {
      loadMessages();
      startRealtime();
      if (state.isAdmin) loadBans();
    }
  }
  function clearUser() {
    state.loggedIn = false; state.userId = null; state.isAdmin = false; state.pseudo = ''; state.email = '';
    state.recovery = false; state.messages = []; state.bans = [];
    stopRealtime();
    cancelEdit();
    updateNav();
    renderChat(true);
  }

  function handleAuth(event, session) {
    var firstTime = !state.authReady;
    state.authReady = true;
    if (event === 'PASSWORD_RECOVERY') state.recovery = true;
    if (session && session.user) applyUser(session.user);
    else if (event === 'SIGNED_OUT' || event === 'INITIAL_SESSION') clearUser();

    if (event === 'PASSWORD_RECOVERY') { go('/nouveau-mot-de-passe', true); return; }
    if (event === 'SIGNED_IN' && justConfirmed) {
      justConfirmed = false;
      toast('Email confirmé, bienvenue !', 'ok');
    }
    if (firstTime && linkError) {
      toast(linkError === 'otp_expired' || /expired/i.test(linkError)
        ? 'Ce lien a expiré ou a déjà été utilisé. Demande-en un nouveau.'
        : 'Ce lien n’est pas valide. Demande-en un nouveau.', 'error');
      linkError = null;
      go('/mot-de-passe-oublie', true);
      return;
    }
    renderRoute();
  }

  if (sb) {
    sb.auth.onAuthStateChange(function (event, session) {
      setTimeout(function () { handleAuth(event, session); }, 0); // jamais d'appel Supabase directement dans ce rappel
    });
    sb.auth.getSession().then(function (res) {
      if (!state.authReady) handleAuth('INITIAL_SESSION', res && res.data ? res.data.session : null);
    });
  } else {
    state.authReady = true;
    toast('Le service de connexion n’a pas pu être chargé. Recharge la page.', 'error');
  }

  $('logoutLink').addEventListener('click', function (e) {
    e.preventDefault();
    var done = function () { clearUser(); go('/'); toast('Tu es déconnecté.'); };
    if (sb) sb.auth.signOut().then(done, done); else done();
  });

  /* ------------------------------------------------------------------ */
  /* Connexion / inscription / récupération                              */
  /* ------------------------------------------------------------------ */
  var cooldowns = {};
  function startCooldown(btn, key, label) {
    var until = Date.now() + COOLDOWN_SECONDS * 1000;
    cooldowns[key] = until;
    var tick = function () {
      var left = Math.ceil((until - Date.now()) / 1000);
      if (left <= 0) { btn.disabled = false; btn.textContent = label; return; }
      btn.disabled = true;
      btn.textContent = 'Renvoyer dans ' + left + ' s';
      setTimeout(tick, 1000);
    };
    tick();
  }

  function setAuthMode(mode) {
    state.authMode = mode;
    var signup = mode === 'signup';
    var tabs = document.querySelectorAll('.auth-tab');
    for (var i = 0; i < tabs.length; i++) {
      var on = tabs[i].getAttribute('data-auth-mode') === mode;
      tabs[i].classList.toggle('active', on);
      tabs[i].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    $('pseudoField').hidden = !signup;
    $('authPasswordConfirmField').hidden = !signup;
    $('termsField').hidden = !signup;
    $('authLoginLinks').hidden = signup;
    $('authPassword').setAttribute('autocomplete', signup ? 'new-password' : 'current-password');
    $('authSubmitBtn').textContent = signup ? 'Créer mon compte' : 'Se connecter';
    $('authPwStrength').textContent = '';
    $('authPwStrength').className = 'pw-strength';
    $('resendWrap').hidden = true;
    setNote($('authNote'), signup
      ? 'Un email de confirmation te sera envoyé pour valider ton adresse.'
      : 'Connexion à ton compte SixteenMarket.');
  }
  var authTabs = document.querySelectorAll('.auth-tab');
  for (var ti = 0; ti < authTabs.length; ti++) {
    authTabs[ti].addEventListener('click', function () { setAuthMode(this.getAttribute('data-auth-mode')); });
  }
  wireStrength('authPassword', 'authPwStrength', function () { return state.authMode === 'signup' ? $('authEmail').value : ''; });
  $('authPassword').addEventListener('input', function () {
    if (state.authMode !== 'signup') { $('authPwStrength').textContent = ''; }
  });

  $('authForm').addEventListener('submit', function (e) {
    e.preventDefault();
    if (!sb) return;
    var note = $('authNote');
    var email = $('authEmail').value.trim();
    var password = $('authPassword').value;
    var signup = state.authMode === 'signup';
    var btn = $('authSubmitBtn');
    $('resendWrap').hidden = true;

    if (signup) {
      var pseudo = $('authPseudo').value.trim();
      if (!PSEUDO_RE.test(pseudo)) { setNote(note, PSEUDO_HELP, 'err'); return; }
      if (!passwordInfo(password, email).valid) { setNote(note, PW_HELP, 'err'); return; }
      if (password !== $('authPasswordConfirm').value) { setNote(note, 'Les deux mots de passe ne correspondent pas.', 'err'); return; }
      if (!$('authTerms').checked) { setNote(note, 'Coche la case pour accepter les conditions d’utilisation et la politique de confidentialité.', 'err'); return; }
      setBusy(btn, true, 'Création…');
      sb.auth.signUp({
        email: email, password: password,
        options: {
          emailRedirectTo: SITE_URL,
          data: { pseudo: pseudo, terms_accepted_at: new Date().toISOString(), terms_version: TERMS_VERSION }
        }
      }).then(function (res) {
        setBusy(btn, false);
        if (res.error) { setNote(note, frError(res.error), 'err'); return; }
        if (res.data && res.data.session) { applyUser(res.data.session.user); finishLogin(); return; }
        setNote(note, 'Presque terminé ! Si cette adresse n’est pas déjà utilisée, un email de confirmation vient d’être envoyé. Clique sur le lien qu’il contient (pense aux spams), puis connecte-toi.', 'ok');
        $('resendWrap').hidden = false;
      });
    } else {
      setBusy(btn, true, 'Connexion…');
      sb.auth.signInWithPassword({ email: email, password: password }).then(function (res) {
        setBusy(btn, false);
        if (res.error) {
          setNote(note, frError(res.error), 'err');
          if (res.error.code === 'email_not_confirmed' || /not confirmed/i.test(res.error.message || '')) $('resendWrap').hidden = false;
          return;
        }
        applyUser(res.data.session.user);
        $('authPassword').value = '';
        finishLogin();
      });
    }
  });
  function finishLogin() {
    var dest = state.next || '/';
    state.next = null;
    toast('Bienvenue ' + state.pseudo + ' !', 'ok');
    go(dest, true);
  }

  $('resendBtn').addEventListener('click', function () {
    var email = $('authEmail').value.trim();
    var note = $('authNote');
    var btn = this;
    if (!email) { setNote(note, 'Entre ton email ci-dessus pour recevoir un nouveau message.', 'err'); return; }
    if (cooldowns.resend && cooldowns.resend > Date.now()) return;
    sb.auth.resend({ type: 'signup', email: email, options: { emailRedirectTo: SITE_URL } }).then(function (res) {
      if (res.error) { setNote(note, frError(res.error), 'err'); return; }
      setNote(note, 'Si un compte non confirmé existe pour cette adresse, un nouvel email vient d’être envoyé.', 'ok');
      startCooldown(btn, 'resend', 'Renvoyer l’email de confirmation');
    });
  });

  $('forgotForm').addEventListener('submit', function (e) {
    e.preventDefault();
    if (!sb) return;
    var note = $('forgotNote');
    var btn = $('forgotBtn');
    var email = $('forgotEmail').value.trim();
    if (cooldowns.forgot && cooldowns.forgot > Date.now()) return;
    setBusy(btn, true, 'Envoi…');
    sb.auth.resetPasswordForEmail(email, { redirectTo: SITE_URL }).then(function (res) {
      setBusy(btn, false);
      var err = res.error;
      var blocking = err && (err.code === 'over_email_send_rate_limit' || err.code === 'over_request_rate_limit' || err.code === 'validation_failed' ||
        /rate limit|only request this once|failed to fetch|network/i.test(err.message || ''));
      if (blocking) { setNote(note, frError(err), 'err'); return; }
      /* Même message que le compte existe ou non : on ne révèle pas quelles adresses ont un compte. */
      setNote(note, 'Si un compte existe avec cette adresse, un email vient d’être envoyé avec un lien valable un temps limité. Pense à vérifier les spams.', 'ok');
      startCooldown(btn, 'forgot', 'Envoyer le lien');
    });
  });

  wireStrength('recoveryPassword', 'recoveryPwStrength', function () { return state.email; });
  $('recoveryForm').addEventListener('submit', function (e) {
    e.preventDefault();
    if (!sb) return;
    var note = $('recoveryNote');
    var pw = $('recoveryPassword').value;
    if (!passwordInfo(pw, state.email).valid) { setNote(note, PW_HELP, 'err'); return; }
    if (pw !== $('recoveryPasswordConfirm').value) { setNote(note, 'Les deux mots de passe ne correspondent pas.', 'err'); return; }
    var btn = $('recoveryBtn');
    setBusy(btn, true, 'Enregistrement…');
    sb.auth.updateUser({ password: pw }).then(function (res) {
      setBusy(btn, false);
      if (res.error) { setNote(note, frError(res.error), 'err'); return; }
      state.recovery = false;
      $('recoveryForm').reset();
      $('recoveryPwStrength').textContent = '';
      toast('Mot de passe mis à jour. Tu es connecté.', 'ok');
      go('/compte', true);
    });
  });

  /* Afficher / masquer les mots de passe */
  document.addEventListener('click', function (e) {
    var toggle = e.target.closest('.pw-toggle');
    if (!toggle) return;
    var input = $(toggle.getAttribute('data-target'));
    if (!input) return;
    var show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    toggle.textContent = show ? 'Masquer' : 'Afficher';
    toggle.setAttribute('aria-label', show ? 'Masquer le mot de passe' : 'Afficher le mot de passe');
  });

  /* ------------------------------------------------------------------ */
  /* Mon compte                                                          */
  /* ------------------------------------------------------------------ */
  $('pseudoForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var note = $('settingsNote');
    var pseudo = $('settingsPseudo').value.trim();
    if (!PSEUDO_RE.test(pseudo)) { setNote(note, PSEUDO_HELP, 'err'); return; }
    sb.auth.updateUser({ data: { pseudo: pseudo } }).then(function (res) {
      if (res.error) { setNote(note, frError(res.error), 'err'); return; }
      state.pseudo = pseudo;
      updateNav();
      setNote(note, 'Pseudo mis à jour. Il sera utilisé pour tes prochains messages.', 'ok');
    });
  });
  wireStrength('settingsPassword', 'settingsPwStrength', function () { return state.email; });
  $('passwordForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var note = $('settingsNote');
    var oldPw = $('settingsOldPassword').value;
    var newPw = $('settingsPassword').value;
    if (newPw !== $('settingsPasswordConfirm').value) { setNote(note, 'Les deux nouveaux mots de passe ne correspondent pas.', 'err'); return; }
    if (!passwordInfo(newPw, state.email).valid) { setNote(note, PW_HELP, 'err'); return; }
    if (newPw === oldPw) { setNote(note, 'Le nouveau mot de passe doit être différent de l’ancien.', 'err'); return; }
    setNote(note, 'Vérification…');
    sb.auth.signInWithPassword({ email: state.email, password: oldPw }).then(function (check) {
      if (check.error) { setNote(note, 'L’ancien mot de passe est incorrect.', 'err'); return; }
      return sb.auth.updateUser({ password: newPw }).then(function (res) {
        if (res.error) { setNote(note, frError(res.error), 'err'); return; }
        $('passwordForm').reset();
        $('settingsPwStrength').textContent = '';
        setNote(note, 'Mot de passe mis à jour.', 'ok');
      });
    });
  });

  $('exportDataBtn').addEventListener('click', function () {
    var btn = this;
    setBusy(btn, true, 'Préparation…');
    sb.rpc('export_my_data').then(function (res) {
      setBusy(btn, false);
      if (res.error) { toast(frError(res.error), 'error'); return; }
      var blob = new Blob([JSON.stringify(res.data, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'sixteenmarket-mes-donnees.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
      toast('Tes données ont été téléchargées.', 'ok');
    });
  });

  $('deleteAccountForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var note = $('settingsNote');
    var pw = $('deleteAccountPassword').value;
    confirmDialog('Supprimer définitivement ton compte et tes messages ? Cette action ne peut pas être annulée.', 'Supprimer mon compte').then(function (ok) {
      if (!ok) return;
      setNote(note, 'Vérification…');
      return sb.auth.signInWithPassword({ email: state.email, password: pw }).then(function (check) {
        if (check.error) { setNote(note, 'Mot de passe incorrect.', 'err'); return; }
        return sb.rpc('delete_own_account').then(function (res) {
          if (res.error) { setNote(note, frError(res.error), 'err'); return; }
          var done = function () { clearUser(); $('deleteAccountForm').reset(); go('/'); toast('Ton compte a été supprimé.', 'ok'); };
          sb.auth.signOut({ scope: 'local' }).then(done, done);
        });
      });
    });
  });

  /* ------------------------------------------------------------------ */
  /* Espace admin                                                        */
  /* ------------------------------------------------------------------ */
  function renderAdmin() {
    if (!state.isAdmin) return;
    $('adminAppsList').innerHTML = state.apps.length ? state.apps.map(function (a) {
      return '<li><span class="who">' + escapeHtml(a.name) + ' <span class="muted">v' + escapeHtml(a.version) + ' · ' + plural(a.downloads, 'téléchargement', 'téléchargements') + '</span></span>' +
        '<span class="admin-actions"><button type="button" class="mini-btn" data-edit-app="' + escapeHtml(a.id) + '">Modifier</button>' +
        '<button type="button" class="mini-btn danger" data-del-app="' + escapeHtml(a.id) + '">Supprimer</button></span></li>';
    }).join('') : '<li>Aucune app.</li>';

    $('adminMessagesList').innerHTML = state.messages.length ? state.messages.slice().reverse().map(function (m) {
      return '<li><span class="who"><strong>' + escapeHtml(m.author) + '</strong> : ' + escapeHtml(m.text) + '</span>' +
        '<span class="admin-actions"><button type="button" class="mini-btn" data-del-msg="' + escapeHtml(m.id) + '">Supprimer</button>' +
        (m.user_id && m.user_id !== state.userId ? '<button type="button" class="mini-btn danger" data-ban="' + escapeHtml(m.user_id) + '" data-ban-name="' + escapeHtml(m.author) + '">Bannir</button>' : '') +
        '</span></li>';
    }).join('') : '<li>Aucun message.</li>';

    $('adminBansList').innerHTML = state.bans.length ? state.bans.map(function (b) {
      return '<li><span class="who">' + escapeHtml(b.email || b.user_id) + ' <span class="muted">' + escapeHtml(formatDate(b.created_at, false)) + '</span></span>' +
        '<span class="admin-actions"><button type="button" class="mini-btn" data-unban="' + escapeHtml(b.user_id) + '">Débannir</button></span></li>';
    }).join('') : '<li>Aucun membre banni.</li>';
  }

  function loadBans() {
    if (!sb || !state.isAdmin) return;
    sb.from('bans').select('user_id,email,created_at').order('created_at', { ascending: false }).then(function (res) {
      if (res.error) { console.error(res.error); return; }
      state.bans = res.data || [];
      renderAdmin();
    });
  }

  function validateImage(file) {
    if (IMAGE_TYPES.indexOf(file.type) === -1) return '« ' + file.name + ' » n’est pas une image PNG, JPG, WebP ou GIF.';
    if (file.size > MAX_IMAGE) return '« ' + file.name + ' » dépasse 5 Mo.';
    return null;
  }
  function uploadMedia(file, folder) {
    var safe = file.name.replace(/[^a-zA-Z0-9.\-_]/g, '_').slice(-80);
    var path = folder + '/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '-' + safe;
    return sb.storage.from(BUCKET).upload(path, file, { cacheControl: '3600', upsert: false }).then(function (res) {
      if (res.error) throw res.error;
      return sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
    });
  }
  function removeFiles(urls) {
    var paths = urls.map(storagePathFromUrl).filter(Boolean);
    if (!paths.length) return Promise.resolve();
    return sb.storage.from(BUCKET).remove(paths).then(function (res) { if (res.error) console.error(res.error); }, function (err) { console.error(err); });
  }

  function startEdit(id) {
    var app = findApp(id);
    if (!app) return;
    state.editingId = app.id;
    $('newAppName').value = app.name;
    $('newAppDesc').value = app.description;
    $('newAppVersion').value = app.version;
    $('newAppSize').value = app.size;
    $('newAppFormat').value = app.format;
    $('newAppFile').required = false;
    $('adminFormTitle').textContent = 'Modifier une app';
    $('adminEditingName').textContent = app.name;
    $('adminEditing').hidden = false;
    $('addAppBtn').textContent = 'Enregistrer les modifications';
    $('addAppForm').scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
  }
  function cancelEdit() {
    state.editingId = null;
    $('adminEditing').hidden = true;
    $('adminFormTitle').textContent = 'Ajouter une app';
    $('addAppBtn').textContent = 'Ajouter';
    $('newAppFile').required = true;
    $('addAppForm').reset();
  }
  $('adminCancelEdit').addEventListener('click', cancelEdit);

  $('newAppFile').addEventListener('change', function () {
    var f = this.files[0];
    if (!f) return;
    if (!$('newAppSize').value) $('newAppSize').value = formatSize(f.size);
    var ext = (f.name.split('.').pop() || '').toLowerCase();
    var formats = { apk: 'APK', exe: 'EXE', msi: 'MSI', ipa: 'iOS (IPA)', zip: 'ZIP', dmg: 'DMG', aab: 'AAB' };
    if (!$('newAppFormat').value && formats[ext]) $('newAppFormat').value = formats[ext];
  });

  $('addAppForm').addEventListener('submit', function (e) {
    e.preventDefault();
    if (!state.isAdmin || !sb) return;
    var form = e.target;
    var editing = state.editingId ? findApp(state.editingId) : null;
    var iconFile = $('newAppIcon').files[0];
    var shotFiles = Array.prototype.slice.call($('newAppScreenshots').files);
    var appFile = $('newAppFile').files[0];

    var images = (iconFile ? [iconFile] : []).concat(shotFiles);
    for (var i = 0; i < images.length; i++) {
      var problem = validateImage(images[i]);
      if (problem) { toast(problem, 'error'); return; }
    }
    if (!editing && !appFile) { toast('Le fichier de l’app est requis.', 'error'); return; }
    if (appFile && appFile.size > MAX_APP_FILE) { toast('« ' + appFile.name + ' » dépasse 50 Mo (limite du plan gratuit).', 'error'); return; }

    var fields = {
      name: $('newAppName').value.trim(), description: $('newAppDesc').value.trim(),
      version: $('newAppVersion').value.trim(), size: $('newAppSize').value.trim(), format: $('newAppFormat').value.trim()
    };
    var btn = $('addAppBtn');
    setBusy(btn, true, 'Envoi en cours…');
    var uploaded = [];
    var createdId = null;
    var up = function (file, folder) { return uploadMedia(file, folder).then(function (url) { uploaded.push(url); return url; }); };

    Promise.all([
      iconFile ? up(iconFile, 'icons') : Promise.resolve(null),
      appFile ? up(appFile, 'files') : Promise.resolve(null)
    ]).then(function (r) {
      if (r[0]) fields.icon_url = r[0];
      if (r[1]) fields.file_url = r[1];
      return editing
        ? sb.from('apps').update(fields).eq('id', editing.id).select().single()
        : sb.from('apps').insert(fields).select().single();
    }).then(function (res) {
      if (res.error) throw res.error;
      if (!editing) createdId = res.data.id;
      var appId = res.data.id;
      return Promise.all(shotFiles.map(function (file, idx) {
        return up(file, 'screenshots').then(function (url) {
          return sb.from('app_screenshots').insert({ app_id: appId, url: url, position: idx }).then(function (r2) {
            if (r2.error) throw r2.error;
          });
        });
      }));
    }).then(function () {
      /* Modification réussie : on supprime les anciens fichiers remplacés. */
      var old = [];
      if (editing) {
        if (iconFile && editing.icon_url) old.push(editing.icon_url);
        if (appFile && editing.file_url) old.push(editing.file_url);
        if (shotFiles.length && editing.screenshots.length) {
          var oldShots = editing.screenshots.map(function (s) { return s.url; });
          old = old.concat(oldShots);
          return sb.from('app_screenshots').delete().in('url', oldShots).then(function () { return removeFiles(old); });
        }
      }
      return removeFiles(old);
    }).then(function () {
      setBusy(btn, false);
      var wasEditing = !!editing;
      cancelEdit();
      toast(wasEditing ? 'App mise à jour.' : 'App ajoutée.', 'ok');
      return loadApps();
    }).catch(function (err) {
      setBusy(btn, false);
      console.error(err);
      /* Retour en arrière : on retire ce qui vient d'être envoyé pour ne pas laisser de fichiers orphelins. */
      var rollback = Promise.resolve();
      if (createdId) {
        rollback = sb.from('app_screenshots').delete().eq('app_id', createdId).then(function () {
          return sb.from('apps').delete().eq('id', createdId);
        });
      }
      rollback.then(function () { return removeFiles(uploaded); }).then(function () { loadApps(); });
      toast('L’envoi a échoué, rien n’a été enregistré. ' + frError(err), 'error');
    });
  });

  $('adminAppsList').addEventListener('click', function (e) {
    var edit = e.target.closest('[data-edit-app]');
    if (edit) { startEdit(edit.getAttribute('data-edit-app')); return; }
    var del = e.target.closest('[data-del-app]');
    if (!del) return;
    var app = findApp(del.getAttribute('data-del-app'));
    if (!app) return;
    confirmDialog('Supprimer « ' + app.name + ' » ainsi que ses fichiers et captures ? Cette action est définitive.', 'Supprimer').then(function (ok) {
      if (!ok) return;
      var urls = [app.icon_url, app.file_url].concat((app.screenshots || []).map(function (s) { return s.url; })).filter(Boolean);
      sb.from('app_screenshots').delete().eq('app_id', app.id).then(function () {
        return sb.from('apps').delete().eq('id', app.id);
      }).then(function (res) {
        if (res.error) { toast(frError(res.error), 'error'); return; }
        return removeFiles(urls).then(function () { toast('App supprimée.', 'ok'); return loadApps(); });
      });
    });
  });

  $('adminMessagesList').addEventListener('click', function (e) {
    var del = e.target.closest('[data-del-msg]');
    if (del) { deleteMessage(del.getAttribute('data-del-msg')); return; }
    var ban = e.target.closest('[data-ban]');
    if (!ban) return;
    var uid = ban.getAttribute('data-ban');
    var name = ban.getAttribute('data-ban-name');
    confirmDialog('Bannir « ' + name + ' » ? Il ne pourra plus écrire et tous ses messages seront supprimés.', 'Bannir').then(function (ok) {
      if (!ok) return;
      sb.rpc('admin_ban_user', { target: uid }).then(function (res) {
        if (res.error) { toast(frError(res.error), 'error'); return; }
        state.messages = state.messages.filter(function (m) { return m.user_id !== uid; });
        renderChat(false);
        loadBans();
        toast('Membre banni.', 'ok');
      });
    });
  });

  $('adminBansList').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-unban]');
    if (!btn) return;
    sb.rpc('admin_unban_user', { target: btn.getAttribute('data-unban') }).then(function (res) {
      if (res.error) { toast(frError(res.error), 'error'); return; }
      loadBans();
      toast('Membre débanni.', 'ok');
    });
  });

  /* ------------------------------------------------------------------ */
  /* Effets visuels (inchangés : confettis, pinceau, gouttes, parallaxe) */
  /* ------------------------------------------------------------------ */
  function confettiBurst(btn) {
    if (reduce) return;
    var rect = btn.getBoundingClientRect();
    var colors = ['#5FA898', '#E2896A', '#A784B0', '#E3AC44'];
    for (var i = 0; i < 14; i++) {
      (function (i) {
        var p = document.createElement('div');
        var size = 6 + Math.random() * 5;
        p.style.position = 'fixed';
        p.style.left = (rect.left + rect.width / 2) + 'px';
        p.style.top = (rect.top + rect.height / 2) + 'px';
        p.style.width = size + 'px'; p.style.height = size + 'px';
        p.style.background = colors[i % colors.length];
        p.style.borderRadius = (Math.random() > 0.5 ? '2px' : '50%');
        p.style.pointerEvents = 'none'; p.style.zIndex = 9999;
        document.body.appendChild(p);
        var angle = Math.random() * Math.PI * 2, dist = 60 + Math.random() * 70;
        var dx = Math.cos(angle) * dist, dy = Math.sin(angle) * dist - 40, rot = Math.floor(Math.random() * 360);
        var anim = p.animate([
          { transform: 'translate(0,0) rotate(0deg)', opacity: 1 },
          { transform: 'translate(' + dx + 'px,' + (dy + 90) + 'px) rotate(' + rot + 'deg)', opacity: 0 }
        ], { duration: 900 + Math.random() * 400, easing: 'cubic-bezier(.2,.7,.4,1)' });
        anim.onfinish = function () { p.remove(); };
      })(i);
    }
  }

  var wraps = document.querySelectorAll('.blob-wrap');
  if (!reduce && wraps.length) {
    var ticking = false;
    var updateParallax = function () {
      var y = window.scrollY;
      wraps.forEach(function (w) { w.style.transform = 'translateY(' + (y * (parseFloat(w.getAttribute('data-depth')) || 0.1)) + 'px)'; });
      ticking = false;
    };
    window.addEventListener('scroll', function () { if (!ticking) { requestAnimationFrame(updateParallax); ticking = true; } }, { passive: true });
  }

  if (!reduce && pointerFine) {
    var trailColors = ['#5FA898', '#E2896A', '#A784B0', '#E3AC44'];
    var lastTrail = 0;
    document.addEventListener('mousemove', function (e) {
      var now = Date.now();
      if (now - lastTrail < 45) return;
      lastTrail = now;
      var dab = document.createElement('div');
      var s = 10 + Math.random() * 8;
      dab.style.position = 'fixed';
      dab.style.left = (e.clientX - s / 2) + 'px';
      dab.style.top = (e.clientY - s / 2) + 'px';
      dab.style.width = s + 'px'; dab.style.height = s + 'px';
      dab.style.borderRadius = '45% 55% 60% 40% / 50% 45% 55% 50%';
      dab.style.background = trailColors[Math.floor(Math.random() * trailColors.length)];
      dab.style.opacity = '.5'; dab.style.mixBlendMode = 'multiply';
      dab.style.pointerEvents = 'none'; dab.style.zIndex = 9998;
      document.body.appendChild(dab);
      dab.animate([{ transform: 'scale(1)', opacity: 0.5 }, { transform: 'scale(2.2)', opacity: 0 }], { duration: 700, easing: 'ease-out' }).onfinish = function () { dab.remove(); };
    });
  }

  var pressPalette = ['#5FA898', '#E2896A', '#A784B0', '#E3AC44'];
  function splatEffect(x, y, color) {
    var s = document.createElement('div');
    var size = 46 + Math.random() * 24;
    s.style.position = 'fixed';
    s.style.left = (x - size / 2) + 'px';
    s.style.top = (y - size / 2) + 'px';
    s.style.width = size + 'px'; s.style.height = size + 'px';
    s.style.borderRadius = '44% 56% 60% 40% / 45% 40% 60% 55%';
    s.style.background = color;
    s.style.opacity = '.6'; s.style.mixBlendMode = 'multiply';
    s.style.pointerEvents = 'none'; s.style.zIndex = 9997;
    document.body.appendChild(s);
    s.animate([
      { transform: 'scale(0)', opacity: 0.65 },
      { transform: 'scale(1.3)', opacity: 0.5, offset: 0.35 },
      { transform: 'scale(1.05)', opacity: 0 }
    ], { duration: 520, easing: 'cubic-bezier(.2,.8,.3,1)' }).onfinish = function () { s.remove(); };
  }
  if (!reduce) {
    document.addEventListener('pointerdown', function (e) {
      var el = e.target.closest && e.target.closest('button,.card,.app-tile,a,.nav-link');
      if (!el) return;
      splatEffect(e.clientX, e.clientY, pressPalette[Math.floor(Math.random() * pressPalette.length)]);
    });
  }

  var footerSlogan = $('footerSlogan');
  if (reduce) footerSlogan.classList.add('drawn');
  else setTimeout(function () { footerSlogan.classList.add('drawn'); }, 700);

  /* ------------------------------------------------------------------ */
  /* Bandeau d'information (aucun cookie de suivi : simple information)  */
  /* ------------------------------------------------------------------ */
  var NOTICE_KEY = 'sm_notice_v1';
  var noticeSeen = false;
  try { noticeSeen = !!localStorage.getItem(NOTICE_KEY); } catch (e) { noticeSeen = false; }
  $('storageNotice').hidden = noticeSeen;
  $('noticeOk').addEventListener('click', function () {
    try { localStorage.setItem(NOTICE_KEY, '1'); } catch (e) { /* ignoré */ }
    $('storageNotice').hidden = true;
  });

  /* ------------------------------------------------------------------ */
  /* Démarrage                                                           */
  /* ------------------------------------------------------------------ */
  console.log('SixteenMarket — build 2026-10-31');
  loadApps();
  renderRoute();
})();
