# Lecon 5 : erreurs et exceptions

Code : [05-erreurs.uchi](05-erreurs.uchi)

```
npm run uchi -- run cours/05-erreurs.uchi
```

## A retenir

**Une exception est un deroulement anormal du programme.** On ne l'attrape que
si on sait quoi en faire : `try`/`except` n'est pas un filet de securite
generique, c'est une decision. Attraper tout avec `except Exception` masque
les fautes de frappe.

**On attrape par type, pas par nom.** `except ValueError` attrape les erreurs
de conversion ; `except (KeyError, TypeError)` attrape deux familles. Comme
les exceptions heritent les unes des autres, `except ArithmeticError` attrape
aussi `ZeroDivisionError`.

**`else` s'execute si rien n'a leve, `finally` s'execute toujours.** `finally`
sert a liberer une ressource ; c'est exactement ce que fait `with`, qui est
la meilleure maniere d'ouvrir un fichier.

```python
try:
    valeur = int(texte)
except ValueError:
    return None
else:
    print('conversion reussie')
```

**`raise` sert a signaler une erreur a l'appelant.** On leve une erreur
decrite, avec un message qui explique : `raise ValueError('un age ne peut pas
etre negatif')`. Le message est lu par quelqu'un d'autre que l'auteur du
code.

**Une exception propre est une classe qui descend d'Exception.** Le message se
passe a la levee ; pas d'attribut a confectionner :

```python
class SoldeInsuffisant(Exception):
    pass

raise SoldeInsuffisant(f'il manque {manque:.2f} euros')
```

**Le delai d'execution** (`--timeout`) leve un `TimeoutError` rattrapable.
Il arrete les boucles du langage, pas une operation native : contre une
expression reguliere catastrophique, seul `Ctrl+C` arrete le programme.

## Pieges

`except` masque aussi les erreurs qu'on n'avait pas prevues. Si une clause
`except` apparait trop souvent, c'est souvent qu'il faut revérifier l'entree
avant d'appeler la fonction.

L'ordre des clauses compte : la premiere qui correspond gagne. On ecrit donc
la plus precise en premier, et la generale (`except Exception`) en dernier.

## Exercices

1. Ecrivez `diviser(a, b)` qui rend `None` quand `b` vaut zero.
2. Ecrivez `lire_entier(texte)` qui rend l'entier ou `None`, en distinguant
   les deux erreurs possibles.
3. Le `finally` s'execute meme apres un `return`. Expliquez ce que fait
   `mesurer` quand la fonction passee leve une erreur.

Les corrections sont en fin de `05-erreurs.uchi`.
