# Lecon 2 : conditions et boucles

Code : [02-conditions-boucles.uchi](02-conditions-boucles.uchi)

```
npm run uchi -- run cours/02-conditions-boucles.uchi
```

## A retenir

**Une condition est un test, pas une égalité.** On écrit `==` pour comparer et
`=` pour affecter. Les six opérateurs sont `==`, `!=`, `<`, `<=`, `>`, `>=`,
et ils s'enchainent : `0 < age < 18` se lit comme en Python.

**`elif` s'arrête au premier vrai.** Une chaine de `if`/`elif`/`else` teste
dans l'ordre et s'arrete. Si on ecrit deux `if` separes, les deux sont
evalues : c'est presque toujours une faute.

**`while` peut ne jamais s'arrêter.** Avant d'ecrire une boucle `while`, on se
demande comment la condition finit par devenir fausse. C'est la source
numero un des programmes qui ne finissent pas. Le delai de `run` les arrete,
mais mieux vaut ne pas dependre de lui.

**`for` parcourt un iterable.** Liste, chaine, tuple, dictionnaire, ensemble,
fichier, et meme la sortie d'une fonction. `range(a, b)` va de `a` a `b`
exclu, comme en Python.

**`break` sort, `continue` passe a la suite.** Le `else` d'une boucle
s'execute quand la boucle se termine normalement, sans `break`. C'est la
maniere idiomatique de dire « j'ai cherche partout, rien trouve ».

**Une comprehension est une boucle qui construit une liste.**

```python
pairs = [n * n for n in range(10) if n % 2 == 0]
```

Lisible pour un ou deux niveaux. Au-dela, on revient a une boucle `for`
ordinaire : c'est plus lisible, et la vitesse n'est pas le sujet.

## Pieges

La variable de la comprehension est **isolee** : `[n for n in [1, 2]]` ne
change pas le `n` de l'exterieur. Utile, mais surprenant la premiere fois.

`enumerate(donnees, 1)` demarre a 1, `enumerate(donnees)` a 0. Pour afficher
« ligne 1 », il faut passer `1` ; sinon on commence a « ligne 0 », ce qui est
inusite dans un terminal.

## Exercices

1. Affichez les nombres de 1 a 20, puis le total de leurs chiffres.
2. Pour une liste de mots, affichez le plus long et tous ceux de la meme
   longueur.
3. Detectez si un nombre est premier, sans ecrire de fonction.

Les corrections sont en fin de `02-conditions-boucles.uchi`.
