# Lecon 6 : fichiers

Code : [06-fichiers.uchi](06-fichiers.uchi)

Depuis le dossier `cours`, parce que la lecon ecrit des fichiers :

```
cd cours
npm run uchi -- run 06-fichiers.uchi
```

## A retenir

**`open` rend un fichier, `with` le ferme.** Le mode est le second argument :
`'r'` lecture (par defaut), `'w'` ecriture en remplacant, `'a'` ajout en
fin de fichier. Un `'w'` sur un fichier existant l'ecrase : c'est le piege
numero un du traitement de fichiers.

**Toujours `with`.** Le bloc se termine, le fichier se ferme, meme si une
exception survient. Ecrire `f = open(...)`, puis `f.close()` en espérant
n'oublier aucune sortie, n'est pas equivalent.

```python
with open('notes.txt') as f:
    contenu = f.read()
```

**Un fichier se parcourt ligne par ligne**, comme une liste :

```python
for ligne in open('notes.txt'):
    print(ligne.strip())
```

`read()` rend tout le contenu, `readline()` une ligne, `readlines()` toutes
les lignes. `write()` ecrit une chaine, `writelines()` ecrit une liste de
chaines.

**Les chemins relatifs partent du repertoire courant**, pas du dossier du
script. C'est une difference avec Python, qui part du dossier du script. C'est
la premiere cause de `FileNotFoundError` inexplique : le fichier existe, mais
on ne le cherche pas ou on croit.

## Fichiers produits

Trois fichiers sont produits par la leçon, ignorés par git :
`notes.txt`, `copie.txt`, `accents.txt`. On les supprime après la leçon.

## Pieges

`write()` n'ajoute pas de saut de ligne tout seul : il faut ecrire `'\n'`.
`print` le fait, `write` non.

La lecture avance dans le fichier : un second `read()` rend la chaine vide,
et `readline()` finit par rendre `''`. Pour relire le contenu, on rouvre le
fichier. Uchi n'a pas de `seek` : on travaille donc sur un fichier ouvert
pour l'ecriture, ou sur un fichier ouvert pour la lecture, jamais les deux.

## Exercices

1. Comptez les lignes et les mots d'un fichier, sans le charger entierement
   en memoire.
2. Recopiez un fichier ligne par ligne dans un autre, en prefixant chaque
   ligne par son numero.
3. Ecrivez `chercher(fichier, mot)` qui rend la premiere ligne contenant
   `mot`, ou `None`, en fermant le fichier meme sans resultat.

Les corrections sont en fin de `06-fichiers.uchi`.
