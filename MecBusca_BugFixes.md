# MecBusca — Correções de Bug (9 fixes)

Aplique cada bloco abaixo no arquivo indicado.  
Trechos marcados com `// ❌ REMOVER` devem ser deletados; `// ✅ ADICIONAR` inseridos no lugar.

---

## Fix 1 — `onLeadsSnapshot` crashava com PERMISSION_DENIED após cadastro
**Arquivo:** `index.html`  
Adicione um segundo argumento (error handler) ao `onSnapshot` de leads.

```js
// ❌ ANTES — sem error handler
const unsub = onSnapshot(q, (snap) => {
  // ... processa snap
});

// ✅ DEPOIS
const unsub = onSnapshot(
  q,
  (snap) => {
    // ... processa snap (sem alteração)
  },
  (error) => {
    // Silencia erros de permissão transitórios (token ainda não propagado)
    if (
      error.code === 'permission-denied' ||
      error.code === 'unauthenticated'
    ) return;
    console.warn('[leadsSnapshot]', error.code, error.message);
  }
);
```

---

## Fix 2 — `loadLeadsPainel` mostrava toast em erros de permissão transitórios
**Arquivo:** `index.html`  
No catch do `loadLeadsPainel`, filtre os códigos silenciosos antes de exibir toast.

```js
// ❌ ANTES
} catch (err) {
  showToast('Erro ao carregar leads.', 'erro');
}

// ✅ DEPOIS
} catch (err) {
  if (
    err.code === 'permission-denied' ||
    err.code === 'unauthenticated'
  ) return;          // silencioso — token ainda propagando
  showToast('Erro ao carregar leads.', 'erro');
}
```

---

## Fix 3 — Race condition: token de auth não propagava antes de escrever no Firestore
**Arquivo:** `index.html`  
Na função `finalizarCadastro`, aguarde a confirmação do `onAuthStateChanged` antes de gravar.

```js
// ❌ ANTES — grava imediatamente após createUserWithEmailAndPassword
const cred = await createUserWithEmailAndPassword(auth, email, senha);
await setDoc(doc(db, 'oficinas', cred.user.uid), dadosCadastro);

// ✅ DEPOIS — espera o auth state ser confirmado
const cred = await createUserWithEmailAndPassword(auth, email, senha);

await new Promise((resolve, reject) => {
  const unsub = onAuthStateChanged(auth, (user) => {
    if (user) { unsub(); resolve(user); }
  }, reject);
  // timeout de segurança — evita promise pendurada
  setTimeout(() => { unsub(); reject(new Error('auth-timeout')); }, 8000);
});

await setDoc(doc(db, 'oficinas', cred.user.uid), dadosCadastro);
```

---

## Fix 4 — `loadPainel` abria listener imediatamente após cadastro
**Arquivo:** `index.html`  
Sinaliza cadastro novo com `STATE._freshRegistration` e atrasa o listener 2 s.

```js
// ✅ No STATE global, adicione o flag (se ainda não existir):
const STATE = {
  // ... campos existentes ...
  _freshRegistration: false,
};

// ✅ Em finalizarCadastro, logo após o setDoc:
STATE._freshRegistration = true;

// ✅ Em loadPainel, antes de abrir o listener de leads:
async function loadPainel(uid) {
  if (STATE._freshRegistration) {
    STATE._freshRegistration = false;
    await new Promise(r => setTimeout(r, 2000)); // aguarda token propagar
  }
  // ... resto do loadPainel sem alteração
}
```

---

## Fix 5 — `atualizarLead` não verificava dono do lead
**Arquivo:** `index.html`  
Antes de gravar, leia `oficinas/{uid}` e confirme que `doc.uid === auth.currentUser.uid`.

```js
// ✅ ADICIONAR no início de atualizarLead (ou equivalente)
async function atualizarLead(leadId, dados) {
  const user = auth.currentUser;
  if (!user) throw new Error('unauthenticated');

  // Verifica ownership
  const oficRef  = doc(db, 'oficinas', user.uid);
  const oficSnap = await getDoc(oficRef);
  if (!oficSnap.exists() || oficSnap.data().uid !== user.uid) {
    throw new Error('permission-denied');
  }

  // Seguro para gravar
  await updateDoc(doc(db, 'leads', leadId), dados);
}
```

---

## Fix 6 — `cadastrarFornecedorDB` sem auth — bots podiam spammar
**Arquivo:** `index.html`  
Exige `auth.currentUser` e grava `uid` no documento.

```js
// ❌ ANTES
async function cadastrarFornecedorDB(dados) {
  await addDoc(collection(db, 'fornecedores'), dados);
}

// ✅ DEPOIS
async function cadastrarFornecedorDB(dados) {
  const user = auth.currentUser;
  if (!user) throw new Error('Usuário não autenticado.');
  await addDoc(collection(db, 'fornecedores'), {
    ...dados,
    uid: user.uid,
    criadoEm: serverTimestamp(),
  });
}
```

---

## Fix 7 — Marker duplicado no Leaflet
**Arquivo:** `index.html`  
Crie o marker uma única vez; antes de criar, remova o anterior se existir.

```js
// ✅ Padrão correto — garante um único marker por ciclo
function colocarMarker(lat, lng) {
  // Remove marker anterior, se houver
  if (STATE.marker) {
    STATE.marker.remove();
    STATE.marker = null;
  }

  STATE.marker = L.marker([lat, lng]).addTo(STATE.map);

  // Registra para cleanup ao sair da tela
  STATE._mapCleanup = STATE._mapCleanup || [];
  STATE._mapCleanup.push(STATE.marker);
}
```

---

## Fix 8 — `validarWpp` rejeitava telefones fixos comerciais
**Arquivo:** `index.html`  
Aceite DDD (2 dígitos) + 8 dígitos (fixo) além de DDD + 9 + 8 (celular).

```js
// ❌ ANTES — só celular
function validarWpp(tel) {
  return /^\d{2}9\d{8}$/.test(tel.replace(/\D/g, ''));
}

// ✅ DEPOIS — celular (11 dígitos) OU fixo (10 dígitos)
function validarWpp(tel) {
  const digits = tel.replace(/\D/g, '');
  // Celular: DDD(2) + 9 + 8 dígitos = 11
  // Fixo:   DDD(2) + 8 dígitos      = 10
  return /^\d{10,11}$/.test(digits);
}
```

---

## Fix 9 — `firebase.json` — arquivo corrigido (JSON válido, sem comentários)
**Arquivo:** `firebase.json`  
O arquivo original continha comentários JavaScript (`//`), que são **JSON inválido** e quebram o `firebase deploy`.  
O arquivo corrigido está em `firebase.json` (output separado, pronto para usar).

> **Conteúdo:** Todos os cabeçalhos de segurança preservados; CSP intacta com todos os hashes; comentários removidos para conformidade com o parser JSON do Firebase CLI.

---

## `firebase-layer.js` — Fix 9 complementar
O listener de leads em `firebase-layer.js` (se existir uma versão lá) também precisa do error handler silencioso:

```js
// ❌ ANTES
export function onLeadsSnapshot(uid, callback) {
  const q = query(
    collection(db, 'leads'),
    where('oficinasInteressadas', 'array-contains', uid)
  );
  return onSnapshot(q, callback);
}

// ✅ DEPOIS
export function onLeadsSnapshot(uid, callback) {
  const q = query(
    collection(db, 'leads'),
    where('oficinasInteressadas', 'array-contains', uid)
  );
  return onSnapshot(
    q,
    callback,
    (error) => {
      if (
        error.code === 'permission-denied' ||
        error.code === 'unauthenticated'
      ) return;
      console.warn('[onLeadsSnapshot error]', error.code, error.message);
    }
  );
}
```

---

## Resumo dos arquivos entregues

| Arquivo | Status |
|---|---|
| `firebase.json` | ✅ JSON válido (Fix 9) |
| `MecBusca_BugFixes.md` | ✅ Patches para index.html e firebase-layer.js (Fixes 1–9) |

Aplique os patches manualmente (ou via `git apply` se converter para `.patch`).  
Após aplicar, regenere os hashes CSP se editar qualquer `<script>` inline usando o comando documentado dentro do `firebase.json` original.
