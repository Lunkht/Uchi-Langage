/**
 * Tests des chemins portables.
 *
 * Chaque fonction est comparee a `node:path`, qui reste la reference sur
 * cette machine. C'est gratuit et ca evite d'inventer une semantique : si
 * les deux convergent sur ce que le langage utilise, le navigateur peut
 * remplacer Node sans que les programmes Uchi changent de comportement.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from '../src/platform/paths.ts';
import * as noeud from 'node:path/posix';

/**
 * La reference de Node, ramenee en chemins POSIX.
 *
 * Sous Windows, `node:path` renvoie `a\b`. Notre module raisonne toujours en
 * `/`, sinon un programme Uchiecrirait des chemins differents selon l'hote.
 * On compare donc la forme portable, ce qui teste la semantique et laisse
 * le separateur etre le notre.
 */
function posix(chemin: string): string {
  return chemin.split(noeud.sep).join('/');
}

test('les chemins portables concordent avec node:path', () => {
  // Ces cas sont ceux que le langage rencontre reellement : imports imbriques,
  // dossiers de travail, et le controle de confinement de `open()`.
  const bases = ['/app', '/app/projet', '/'];
  const cibles = ['a', 'a.uchi', './a', 'a/b/c.uchi', '../partage', '../..', '/abs/chemin', 'a//b/./c', 'a/x/../b'];
  for (const base of bases) {
    for (const cible of cibles) {
      const attendu = posix(noeud.resolve(base, cible));
      const obtenu = resolve(base, cible);
      assert.equal(obtenu, attendu, `resolve(${base}, ${cible})`);
      // `normalize` ne s'applique qu'a un chemin seul, sans base.
      assert.equal(normalize(cible), posix(noeud.normalize(cible)), `normalize(${cible})`);
      // `relative` n'a de sens qu'entre deux chemins du meme style. Les
      // comparer directement avec node:path ramene a `a\b` sous Windows :
      // on se contente d'une coherence interieure : depuis un chemin normalise
      // vers un autre, on doit pouvoir reconstruire.
      const reconstruit = resolve(base, relative(base, obtenu));
      assert.equal(reconstruit, normalize(obtenu), `relative coherent pour ${base}, ${obtenu}`);
    }
  }
});

test('dirname et basename concordent avec node:path', () => {
  for (const chemin of ['a', 'a.uchi', '/a.uchi', '/app/a.uchi', '/app/projet/', 'a/b/c', '/']) {
    assert.equal(dirname(chemin), posix(noeud.dirname(chemin)), `dirname(${chemin})`);
    assert.equal(basename(chemin), posix(noeud.basename(chemin)), `basename(${chemin})`);
    assert.equal(extname(chemin), posix(noeud.extname(chemin)), `extname(${chemin})`);
  }
  assert.equal(basename('/app/a.uchi', '.uchi'), 'a');
});

test('isAbsolute et sep ne dependent pas de la plateforme', () => {
  // Sous Node sur Windows, `node:path` dirait que `C:\x` est absolu. Uchi
  // raisonne en chemins POSIX, donc la reponse ne doit pas varier d'un hote
  // a l'autre : c'est ce qui permet au navigateur de se substituer a Node.
  assert.equal(sep, '/');
  assert.equal(isAbsolute('/app'), true);
  assert.equal(isAbsolute('app'), false);
  assert.equal(isAbsolute('./app'), false);
  assert.equal(isAbsolute(''), false);
});

test('join ignore les morceaux vides, comme node:path', () => {
  for (const morceaux of [['', 'a'], ['a', '', 'b'], ['a', 'b'], ['', ''], ['/', 'a']]) {
    assert.equal(join(...morceaux), posix(noeud.join(...morceaux)), `join(${JSON.stringify(morceaux)})`);
  }
});

test('normalize ne laisse pas remonter au-dessus de la racine', () => {
  // `/..` vaut `/` sous POSIX : c'est ce qui empeche `open()` de s'echapper
  // par une suite de `..` dans un chemin absolu.
  assert.equal(normalize('/..'), '/');
  assert.equal(normalize('/../../app'), '/app');
  assert.equal(normalize('/app/../..'), '/');
  // En relatif, `..` se conserve : c'est le seul endroit ou il a un sens.
  assert.equal(normalize('../..'), '../..');
  assert.equal(normalize('./a/../..'), '..');
});