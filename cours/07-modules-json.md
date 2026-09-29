# Lecon 7 : modules, JSON et texte

Code : [07-modules-json.uchi](07-modules-json.uchi), avec le module
[outils.uchi](outils.uchi)

Depuis le dossier `cours` :

```
cd cours
npm run uchi -- run 07-modules-json.uchi
```

## Modules

**Un module est un fichier `.uchi` qui expose des definitions.** `import
outils` le charge et rend son nom disponible ; ensuite on ecrit
`outils.ttc(100)`. Le fichier de la lecon est `outils.uchi` : le nom doit etre
un identifiant valide, on ne peut pas importer `07-outils.uchi`.

`from outils import ttc` amene le nom directement, sans le prefixe. C'est plus
court, mais a la lecture on ne sait plus d'ou vient la fonction. Dans un
petit script, c'est acceptable ; dans un gros, on prefere le prefixe.

`__name__` vaut `'__main__'` quand on lance le fichier, et le nom du module
quand un autre fichier l'importe. C'est le filet habituel :

```python
if __name__ == '__main__':
    print(outils.ttc(100))
```

Ce qui est dans le corps du module s'execute a chaque importation, donc la
demonstration va dans le `if`, pas au niveau du module.

## JSON

**JSON est le format d'echange** : listes, dictionnaires, chaines, nombres,
booleens, `null`. On ecrit une chaine avec `dumps`, on relit avec `loads`, et
on travaille directement sur un fichier avec `dump` et `load`.

```python
with open('config.json', 'w') as f:
    json.dump(donnees, f, indent=2, sort_keys=True)

with open('config.json') as f:
    donnees = json.load(f)
```

`indent=2` rend le fichier lisible par un humain, `sort_keys=True` le rend
stable, ce qui permet de comparer deux versions. `None` et `True` deviennent
`null` et `true`. Un JSON invalide lève `json.JSONDecodeError`, qui descend de
`ValueError` : on peut donc l'attraper par `ValueError` si le détail n'a pas
d'importance.

La leçon écrit `commande.json` dans le dossier courant ; il est ignoré par
git et peut être supprimé après coup.

## Texte et expressions regulieres

Le module `string` gather les constantes (`ascii_lowercase`, `digits`,
`punctuation`) et quelques outils (`capwords`, `split`, `join`).

`re` vient de Python, les motifs sont identiques :

| Fonction | Effet |
|----------|-------|
| `search` | cherche n'importe ou, rend un objet `Match` ou `None` |
| `match` | colle le motif au debut du texte |
| `fullmatch` | exige que tout le texte corresponde |
| `findall` | rend toutes les trouvailles dans une liste |
| `sub` | remplace toutes les occurrences |
| `compile` | compile le motif pour le reutiliser |

Les groupes numeres (`(\d+)`) capturent une partie du motif, les groupes
nomes (`(?P<cle>\w+)`) rendent le code lisible quand il y a plusieurs valeurs
a extraire. `sub` les rappelle avec `\1` ou `\g<cle>`. Un motif compile avec
`re.compile(motif, re.I)` est insensible a la casse.

## Pieges

Un motif mal ferme ne leve une erreur qu'a la compilation, donc au premier
`match`. On compile une fois, en tete de programme, plutot qu'a chaque
boucle.

`findall` avec un seul groupe rend des chaines ; avec deux groupes, il rend
des tuples. C'est une source de surprises : un groupe de plus change la
forme du resultat.

## Exercices

1. Montrez qu'un module n'est charge qu'une fois.
2. Ecrivez `vers_json(donnees, chemin)` et `depuis_json(chemin)`, avec une
   erreur claire si le fichier est absent.
3. Extrayez tous les nombres d'un texte et rendez leur somme, en une
   expression reguliere.

Les corrections sont en fin de `07-modules-json.uchi`.
