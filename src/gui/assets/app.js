/*
 * Editeur Uchi : saisie, surcouche de coloration, gouttiere et arbre de
 * fichiers. L'editeur est un `textarea` transparent pose sur une surcouche
 * coloree : la mise en page des deux est identique, ce qui donne une
 * coloration sans dependance ni `contenteditable`.
 */
(function () {
  'use strict';

  var INDENT = '    ';

  var saisie = document.getElementById('saisie');
  var surcouche = document.getElementById('surcouche');
  var gouttiere = document.getElementById('gouttiere');
  var arbre = document.getElementById('arbre');
  var filtre = document.getElementById('filtre');
  var titre = document.getElementById('titre');
  var etat = document.getElementById('etat');
  var position = document.getElementById('position');
  var taille = document.getElementById('taille');
  var diagnostic = document.getElementById('diagnostic');
  var racine = document.getElementById('racine');

  var chemin = null;      // chemin relatif du fichier ouvert
  var sale = false;       // modifications non enregistrees
  var arbreCourant = [];
  var minuteur = null;
  var minuteurBrouillon = null;

  /* ------------------------------------------------------------------ reseau */

  function api(method, url, corps) {
    return fetch(url, {
      method: method,
      headers: corps === undefined ? {} : { 'content-type': 'application/json' },
      body: corps === undefined ? undefined : JSON.stringify(corps),
    }).then(function (reponse) {
      return reponse.json().then(function (data) {
        if (!reponse.ok) throw new Error(data.error || ('erreur ' + reponse.status));
        return data;
      });
    });
  }

  /* ------------------------------------------------------------- surcouche */

  function rafraichir() {
    surcouche.innerHTML = UchiHighlight.highlight(saisie.value) + '\n';
    paintGutter();
    majPosition();
  }

  function paintGutter() {
    var lignes = saisie.value.split('\n').length;
    var html = '';
    for (var i = 1; i <= lignes; i++) {
      html += '<div class="' + (i === ligneFautive ? 'ligne-erreur' : '') + '">' + i + '</div>';
    }
    gouttiere.innerHTML = html;
  }

  var ligneFautive = 0;

  function majPosition() {
    var avant = saisie.value.slice(0, saisie.selectionStart);
    var lignes = avant.split('\n');
    position.textContent = 'Ln ' + lignes.length + ', Col ' + (lignes[lignes.length - 1].length + 1);
    var total = saisie.value.length;
    taille.textContent = total + (total > 1 ? ' caractères' : ' caractère');
  }

  /* ---------------------------------------------------------------- edition */

  function ligneCourante() {
    var debut = saisie.value.lastIndexOf('\n', saisie.selectionStart - 1) + 1;
    var fin = saisie.value.indexOf('\n', saisie.selectionStart);
    if (fin === -1) fin = saisie.value.length;
    return { debut: debut, fin: fin, texte: saisie.value.slice(debut, fin) };
  }

  function selectionLignes() {
    var debut = saisie.value.lastIndexOf('\n', saisie.selectionStart - 1) + 1;
    var fin = saisie.value.indexOf('\n', saisie.selectionEnd);
    if (fin === -1) fin = saisie.value.length;
    return { debut: debut, fin: fin };
  }

  function remplacer(debut, fin, texte, curseur) {
    saisie.setRangeText(texte, debut, fin, 'end');
    if (curseur !== undefined) saisie.selectionStart = saisie.selectionEnd = curseur;
    changer();
  }

  /** Entree : reprend l'indentation, ajoute un niveau apres un `:`. */
  function surEntree(evenement) {
    var ligne = ligneCourante();
    var indent = /^[ \t]*/.exec(ligne.texte)[0];
    var ouvreBloc = /:\s*(#.*)?$/.test(ligne.texte);
    var texte = '\n' + indent + (ouvreBloc ? INDENT : '');
    evenement.preventDefault();
    remplacer(ligne.fin, ligne.fin, texte);
  }

  /** Retour arriere : retire un niveau d'indentation complet. */
  function surRetourArriere(evenement) {
    var ligne = ligneCourante();
    if (ligne.texte === '' || !/^[ ]+$/.test(ligne.texte)) return;
    if (ligne.texte.length < INDENT.length || /\S/.test(ligne.texte.slice(-INDENT.length))) return;
    evenement.preventDefault();
    supprimerINDENT();
  }

  /** Tabulation : indente la ligne ou chaque ligne de la selection. */
  function indenter() {
    if (saisie.selectionStart === saisie.selectionEnd) {
      remplacer(saisie.selectionStart, saisie.selectionEnd, INDENT);
      return;
    }
    var plage = selectionLignes();
    var lignes = saisie.value.slice(plage.debut, plage.fin).split('\n');
    remplacer(plage.debut, plage.fin, lignes.map(function (l) {
      return l === '' ? l : INDENT + l;
    }).join('\n'));
    saisie.setSelectionRange(
      plage.debut + INDENT.length,
      plage.fin + INDENT.length * (lignes.length - 1),
    );
  }

  /** Retire un niveau d'indentation aux lignes de la selection. */
  function supprimerINDENT() {
    var plage = selectionLignes();
    var lignes = saisie.value.slice(plage.debut, plage.fin).split('\n');
    var retires = 0;
    var texte = lignes.map(function (l) {
      if (l.startsWith(INDENT)) { retires += INDENT.length; return l.slice(INDENT.length); }
      var sansTabs = l.replace(/^[ \t]+/, '');
      retires += l.length - sansTabs.length;
      return sansTabs;
    }).join('\n');
    remplacer(plage.debut, plage.fin, texte, plage.debut + Math.max(0, retires));
  }

  function changer() {
    sale = chemin !== null;
    etat.textContent = sale ? 'modifié' : '';
    etat.className = sale ? 'etat sale' : 'etat';
    rafraichir();
    planifierBrouillon();
    planifierAnalyse();
  }

  /* -------------------------------------------------------------- analyse */

  /** L'analyse porte sur le tampon, pas sur le fichier : elle est differee. */
  function planifierAnalyse() {
    if (chemin === null) return;
    if (minuteur !== null) clearTimeout(minuteur);
    minuteur = setTimeout(analyser, 700);
  }

  function analyser() {
    if (chemin === null) return;
    api('POST', '/api/check', { path: chemin, text: saisie.value })
      .then(function (data) {
        if (data.ok) {
          ligneFautive = 0;
          diagnostic.className = 'diagnostic ok';
          diagnostic.textContent = 'analyse : aucune erreur';
        } else {
          ligneFautive = data.error.line;
          diagnostic.className = 'diagnostic';
          diagnostic.textContent = 'ligne ' + data.error.line + ' : ' + data.error.message;
        }
        paintGutter();
      })
      .catch(function (erreur) {
        diagnostic.className = 'diagnostic';
        diagnostic.textContent = erreur.message;
      });
  }

  /* ---------------------------------------------------------------- fichiers */

  function ouvrir(cheminRelatif) {
    if (salemodification()) return;
    api('GET', '/api/file?path=' + encodeURIComponent(cheminRelatif)).then(function (data) {
      chemin = data.path;
      // Un brouillon plus recent que le fichier est conserve : recharger la
      // page ne perd pas le travail en cours.
      var brouillon = lireBrouillon(data.path);
      if (brouillon !== null && brouillon !== data.text) {
        saisie.value = brouillon;
        sale = true;
        etat.textContent = 'modifié';
        etat.className = 'etat sale';
      } else {
        saisie.value = data.text;
        sale = false;
        etat.textContent = '';
        etat.className = 'etat';
      }
      titre.textContent = data.path;
      document.title = data.path + ' — Uchi';
      localStorage.setItem('uchi.fichier', data.path);
      selectionnerArbre();
      ligneFautive = 0;
      diagnostic.textContent = '';
      rafraichir();
      planifierAnalyse();
    }).catch(function (erreur) {
      diagnostic.className = 'diagnostic';
      diagnostic.textContent = erreur.message;
    });
  }

  function enregistrer() {
    if (chemin === null) return;
    api('PUT', '/api/file?path=' + encodeURIComponent(chemin), { text: saisie.value })
      .then(function () {
        sale = false;
        etat.textContent = 'enregistré';
        etat.className = 'etat';
        oublierBrouillon(chemin);
        chargerArbre();
        analyser();
      })
      .catch(function (erreur) {
        diagnostic.className = 'diagnostic';
        diagnostic.textContent = erreur.message;
      });
  }

  function nouveau() {
    var nom = window.prompt('Nom du nouveau fichier', 'nouveau.uchi');
    if (!nom) return;
    api('POST', '/api/file', { path: nom }).then(function (data) {
      return chargerArbre().then(function () { ouvrir(data.path); });
    }).catch(function (erreur) {
      diagnostic.className = 'diagnostic';
      diagnostic.textContent = erreur.message;
    });
  }

  function chargerArbre() {
    return api('GET', '/api/tree').then(function (data) {
      racine.textContent = data.root;
      racine.title = data.root;
      arbreCourant = data.files;
      peindreArbre();
      return data;
    });
  }

  function peindreArbre() {
    var texte = filtre.value.trim().toLowerCase();
    arbre.innerHTML = '';
    arbreCourant.forEach(function (entree) {
      if (texte !== '' && entree.name.toLowerCase().indexOf(texte) === -1) return;
      var item = document.createElement('li');
      item.className = entree.directory ? 'dossier' : 'taille';
      item.dataset.chemin = entree.path;
      if (!entree.directory) item.dataset.taille = entree.size + ' o';
      item.textContent = (entree.directory ? entree.name + '/' : entree.name);
      if (entree.path === chemin) item.className += ' actif';
      if (!entree.directory) item.addEventListener('click', function () { ouvrir(entree.path); });
      arbre.appendChild(item);
    });
  }

  function selectionnerArbre() {
    Array.prototype.forEach.call(arbre.children, function (item) {
      item.className = item.className.replace(' actif', '');
      if (item.dataset.chemin === chemin) item.className += ' actif';
    });
  }

  function salemodification() {
    if (!sale) return false;
    return !window.confirm('Le fichier n\'est pas enregistre. Abandonner les modifications ?');
  }

  /** Le brouillon est ecrit avec delai : une frappe ne doit pas bloquer. */
  function planifierBrouillon() {
    if (minuteurBrouillon !== null) clearTimeout(minuteurBrouillon);
    minuteurBrouillon = setTimeout(memoriserBrouillon, 400);
  }

  function memoriserBrouillon() {
    if (chemin === null) return;
    try {
      localStorage.setItem('uchi.brouillon.' + chemin, saisie.value);
    } catch (e) {
      /* quota atteint : le brouillon est un confort, pas une obligation */
    }
  }

  function lireBrouillon(cheminRelatif) {
    try {
      return localStorage.getItem('uchi.brouillon.' + cheminRelatif);
    } catch (e) {
      return null;
    }
  }

  function oublierBrouillon(cheminRelatif) {
    try {
      localStorage.removeItem('uchi.brouillon.' + cheminRelatif);
    } catch (e) {
      /* rien a faire */
    }
  }

  /* ------------------------------------------------------------------ evenements */

  saisie.addEventListener('input', change);
  saisie.addEventListener('keydown', function (evenement) {
    var modifieur = evenement.ctrlKey || evenement.metaKey;
    if (modifieur && evenement.key.toLowerCase() === 's') {
      enregistrer();
      evenement.preventDefault();
      return;
    }
    if (modifieur && evenement.key.toLowerCase() === 'n') {
      nouveau();
      evenement.preventDefault();
      return;
    }
    if (evenement.key === 'Tab') {
      if (evenement.shiftKey) supprimerINDENT(); else indenter();
      evenement.preventDefault();
      return;
    }
    if (evenement.key === 'Enter') { surEntree(evenement); return; }
    if (evenement.key === 'Backspace') { surRetourArriere(evenement); return; }
  });
  saisie.addEventListener('scroll', function () {
    surcouche.scrollTop = saisie.scrollTop;
    surcouche.scrollLeft = saisie.scrollLeft;
    gouttiere.scrollTop = saisie.scrollTop;
  });
  saisie.addEventListener('keyup', majPosition);
  saisie.addEventListener('click', majPosition);
  window.addEventListener('resize', rafraichir);
  window.addEventListener('beforeunload', function (evenement) {
    if (!salemodification()) return;
    evenement.preventDefault();
    evenement.returnValue = '';
  });

  filtre.addEventListener('input', peindreArbre);
  document.getElementById('enregistrer').addEventListener('click', enregistrer);
  document.getElementById('nouveau').addEventListener('click', nouveau);
  document.getElementById('verifier').addEventListener('click', analyser);

  /* ------------------------------------------------------------------ demarrage */

  api('GET', '/api/grammar').then(function (data) {
    UchiHighlight.configure(data.grammar);
    return chargerArbre();
  }).then(function (data) {
    var fichiers = data.files.filter(function (entree) { return !entree.directory; });
    var retenu = localStorage.getItem('uchi.fichier');
    var choix = fichiers.find(function (entree) { return entree.path === retenu; }) || fichiers[0];
    if (choix === undefined) {
      saisie.value = '# Nouveau script Uchi\n\n';
      changer();
      return;
    }
    ouvrir(choix.path);
  }).catch(function (erreur) {
    diagnostic.className = 'diagnostic';
    diagnostic.textContent = erreur.message;
  });
})();
