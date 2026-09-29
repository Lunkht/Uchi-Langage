import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const racine = join(dirname(fileURLToPath(import.meta.url)), '..');
const cours = join(racine, 'cours');
const cli = join(racine, 'bin', 'uchi.mjs');

/**
 * Les lecons sont lancees par la vraie commande `run`, depuis le dossier
 * `cours` : c'est la seule facon de verifier ce que voit un eleve, chemins
 * relatifs et import de modules compris. Un fichier de sortie non vide, sans
 * trace d'erreur interne, est la preuve que la lecon tourne.
 */
function lancerLecon(nom: string): string {
  return execFileSync('node', [cli, 'run', nom], {
    cwd: cours,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function nommer(fichier: string): string {
  return fichier.replace('.uchi', '');
}

const lecons = readdirSync(cours)
  .filter((fichier) => /^\d\d-.*\.uchi$/.test(fichier))
  .sort();

test('le dossier des cours contient les huit lecons attendues', () => {
  assert.deepEqual(lecons, [
    '01-valeurs.uchi',
    '02-conditions-boucles.uchi',
    '03-fonctions.uchi',
    '04-collections.uchi',
    '05-erreurs.uchi',
    '06-fichiers.uchi',
    '07-modules-json.uchi',
    '08-classes.uchi',
  ]);
});

for (const lecon of lecons) {
  test(`la lecon ${nommer(lecon)} s'execute sans erreur`, () => {
    const sortie = lancerLecon(lecon);
    assert.ok(sortie.length > 0, 'la lecon n\'a rien affiche');
    assert.ok(!/Erreur interne|Traceback/.test(sortie), sortie);
  });
}

test('chaque lecon a une fiche et des exercices corriges', () => {
  for (const lecon of lecons) {
    const nom = nommer(lecon);
    const code = readFileSync(join(cours, lecon), 'utf8');
    const fiche = readFileSync(join(cours, `${nom}.md`), 'utf8');
    // Les exercices sont commentes, avec leur correction juste dessous.
    const exercices = (code.match(/^# Exercice \d+/gm) ?? []).length;
    const corrections = (code.match(/^#   \w/gm) ?? []).length;
    assert.ok(exercices >= 2, `${nom} : ${exercices} exercice(s) seulement`);
    assert.ok(corrections >= exercices, `${nom} : une correction manque`);
    assert.ok(fiche.includes(lecon), `${nom}.md ne renvoie pas vers ${lecon}`);
  }
});

test('le module partage de la lecon 7 est importe par son nom', () => {
  const code = readFileSync(join(cours, '07-modules-json.uchi'), 'utf8');
  assert.match(code, /^import outils$/m);
  assert.ok(readFileSync(join(cours, 'outils.uchi'), 'utf8').includes('def ttc'));
});

test('les fichiers ecrits par les lecons sont ignores par git', () => {
  const ignore = readFileSync(join(racine, '.gitignore'), 'utf8');
  for (const fichier of ['notes.txt', 'copie.txt', 'accents.txt', 'commande.json']) {
    assert.ok(ignore.includes(`cours/${fichier}`), `${fichier} absent du .gitignore`);
    rmSync(join(cours, fichier), { force: true });
  }
});
