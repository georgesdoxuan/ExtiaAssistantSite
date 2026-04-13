# CLAUDE.md

## Contexte projet

Ce projet contient 2 sections dans une app Next.js + backend Express :

1. **Audit Mailchimp**
2. **Audit site extia.fr**

Objectif global :
- détecter ce qui n’est pas à jour par rapport à une requête utilisateur
- **ne jamais modifier/supprimer dans Mailchimp**
- mode **lecture seule uniquement**

---

## Contraintes strictes

### Mailchimp
- Interdiction de toute écriture API Mailchimp (`POST`, `PUT`, `PATCH`, `DELETE`)
- Seulement `GET`
- Le code doit rester **read-only** à 100%

### Audit site
- Éviter les hallucinations
- Préférer des résultats déterministes / vérifiables
- Afficher des URLs exactes des pages concernées

---

## Stack actuelle

- Front : Next.js (`app/`)
- API : Express (`src/server.js`)
- Lancement : `npm run dev`
- Variables : `.env.local`

Scripts :
- `npm run dev` => API + WEB
- `npm run api`
- `npm run web`

---

## État actuel à corriger

### 1) Mailchimp : détection des emails “programmés”
Problème :
- Le compte renvoie surtout des campagnes `sent` et `save`
- Peu/pas de campagnes `schedule` détectées
- `send_time` vide sur les `save`
- Résultat : `0 campagnes programmées` en mode strict

Ce qui est attendu :
- Auditer uniquement les emails réellement programmés à date/heure futures
- Si aucun contenu auditable : message clair, pas de faux positifs
- Garder debug minimal, lisible

### 2) Audit site extia.fr : qualité des résultats
Problème :
- Réponses parfois fausses/hallucinées
- Index parfois trop pauvre (peu d’URLs)
- L’utilisateur veut URL de page précise non à jour

Ce qui est attendu :
- Pipeline backend:
  1. sélectionner catégories pertinentes
  2. sélectionner quelques URLs candidates
  3. audit avec preuves vérifiables
- Pas d’invention de faits (dates/chiffres)
- Issues uniquement si preuve textuelle réelle
- URL cliquable dans UI

---

## UX demandée

- Garder le design actuel (light, cartes)
- Side panel avec navigation :
  - Audit Mailchimp
  - Audit site extia.fr
- Police normale (pas monospace) dans champs/résultats côté site
- Résultats en français

---

## Variables .env (exemples)

- `MAILCHIMP_API_KEY=...-us3`
- `OPENAI_API_KEY=...`
- `OPENAI_MODEL=gpt-4.1-mini`
- `NEXT_PUBLIC_API_BASE_URL=http://localhost:3001`
- `PORT_API=3001`
- `PORT_UI=3000`
- `MAILCHIMP_WORKFLOWS_COUNT=200`
- `MAILCHIMP_CAMPAIGNS_COUNT=200`
- `MAILCHIMP_MAX_CAMPAIGNS_TO_AUDIT=30`

---

## Ce qu’il faut faire en priorité

1. Stabiliser la logique Mailchimp “scheduled only” selon API réelle (sans faux zéro injustifié)
2. Stabiliser l’indexation site (plusieurs URLs fiables)
3. Garantir sorties factuelles (preuve stricte)
4. Réduire coût/token via sélection catégories + sous-ensemble de pages
5. Nettoyer le debug (garder utile, retirer bruit)

---

## Vérification manuelle minimale

Après modifs :
1. `npm run dev`
2. Audit site :
   - indexer
   - lancer audit
   - vérifier pages indexées > 1
   - vérifier URLs précises dans issues
3. Audit Mailchimp :
   - vérifier stats snapshot cohérentes
   - vérifier absence de faux positifs si aucun contenu auditable
4. Aucun appel Mailchimp en écriture

---

## Note importante sécurité

Clés API ont été manipulées pendant les tests.
- Ne jamais commit `.env.local`
- Recommander rotation des clés en cas de doute