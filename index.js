require('dotenv').config();

const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();

app.use(express.json());

app.use(cors({
  origin: "*"
}));

const PORT = process.env.PORT || 3000;

// ===============================
// 🔐 AZURE CONFIG
// ===============================
const ORG = process.env.AZURE_ORG;
const PROJECT = process.env.AZURE_PROJECT;
const PAT = process.env.AZURE_PAT;

const auth = Buffer.from(`:${PAT}`).toString('base64');

// ===============================
// 🧠 CACHE GLOBAL
// ===============================
let cache = {
  dashboard: null,
  lastSync: null,
  loading: false
};

// ===============================
// 🧠 MAPEAMENTO KANBAN
// ===============================
function mapKanbanColumn(status) {

  const normalized = (status || "").toLowerCase();

  // FILA SELLER
  if (
    normalized.includes("new") ||
    normalized.includes("novo")
  ) {
    return "Fila Seller";
  }

  // FILA ANALISTA
  if (
    normalized.includes("approved") ||
    normalized.includes("ready") ||
    normalized.includes("analista")
  ) {
    return "Fila Analista";
  }

  // EM ANDAMENTO
  if (
    normalized.includes("active") ||
    normalized.includes("andamento") ||
    normalized.includes("doing") ||
    normalized.includes("progress")
  ) {
    return "Em Andamento";
  }

  // IMPEDIMENTO
  if (
    normalized.includes("blocked") ||
    normalized.includes("imped")
  ) {
    return "Em Impedimento";
  }

  // CONCLUÍDO
  if (
    normalized.includes("done") ||
    normalized.includes("closed") ||
    normalized.includes("completed") ||
    normalized.includes("concl")
  ) {
    return "Concluído";
  }

  return "Fila Seller";
}

// ===============================
// 🧠 SINCRONIZAÇÃO PRINCIPAL
// ===============================
async function syncDashboard() {

  if (cache.loading) {
    console.log("⏳ Sync já em execução...");
    return;
  }

  try {

    cache.loading = true;

    console.log("🔄 Sync Azure iniciado...");

    // ===============================
    // QUERY WIQL
    // ===============================
const query = {
  query: `
    SELECT
      [System.Id]
    FROM WorkItems
    WHERE
      [System.TeamProject] = '${PROJECT}'

      AND [System.WorkItemType] IN (
        'Backoffice',
        'Marketplaces'
      )

      AND [System.AreaPath] IN (
        'Onboarding - E-Commerce Domain\\ANYMARKET\\ANYMARKET Brasil\\Thrusters\\Marketplace Domain\\Ágeis (Performance e Enterprise)',
        'Onboarding - E-Commerce Domain\\ANYMARKET\\ANYMARKET Brasil\\Kickstarters\\Backoffice'
      )

      AND [System.ChangedDate] >= '2025-01-01T00:00:00Z'

    ORDER BY [System.ChangedDate] DESC
  `
};
    // ===============================
    // BUSCA IDS
    // ===============================
    const wiqlResponse = await axios.post(
      `https://dev.azure.com/${ORG}/${PROJECT}/_apis/wit/wiql?api-version=7.0`,
      query,
      {
        headers: {
          Authorization: `Basic ${auth}`
        },
        timeout: 60000
      }
    );

    const ids = wiqlResponse.data.workItems
  .map(w => w.id)
  .slice(0, 1000);
    
    console.log("TOTAL IDS:", ids.length);

    console.log(`📦 Total IDs encontrados: ${ids.length}`);

    if (ids.length === 0) {

  console.log("⚠️ Nenhum item encontrado");

  cache.dashboard = {
    kpis: {
      total: 0,
      done: 0,
      active: 0,
      blocked: 0,
      progress: 0
    },
    kanban: {
      "Fila Seller": [],
      "Fila Analista": [],
      "Em Andamento": [],
      "Em Impedimento": [],
      "Concluído": []
    },
    users: []
  };

  return;
}

    // ===============================
    // BUSCA EM LOTES
    // ===============================
    const chunkSize = 50;

    let allItems = [];

    for (let i = 0; i < ids.length; i += chunkSize) {

      const chunk = ids.slice(i, i + chunkSize);

      try {

        const resp = await axios.get(
          `https://dev.azure.com/${ORG}/${PROJECT}/_apis/wit/workitems?ids=${chunk.join(',')}&api-version=7.0`,
          {
            headers: {
              Authorization: `Basic ${auth}`
            },
            timeout: 60000
          }
        );

        allItems = allItems.concat(resp.data.value);

        console.log(`✅ Lote carregado ${i + chunk.length}/${ids.length}`);

      } catch (err) {

        console.log(`❌ Erro lote ${i}`);

        console.log(err.message);
      }
    }

    console.log(`📊 Total carregado: ${allItems.length}`);

    // ===============================
    // KANBAN
    // ===============================
    const kanban = {
      "Fila Seller": [],
      "Fila Analista": [],
      "Em Andamento": [],
      "Em Impedimento": [],
      "Concluído": []
    };

    // ===============================
    // USERS
    // ===============================
    const users = {};

    // ===============================
    // FILTRO ITENS PRINCIPAIS
    // ===============================
    const filteredItems = allItems.filter(item => {

      const fields = item.fields || {};

      const workItemType = (
        fields["System.WorkItemType"] || ""
      ).toLowerCase();

      // REMOVE SUBTASKS
      if (
        workItemType === "task" ||
        workItemType === "subtask"
      ) {
        return false;
      }

      return true;
    });

    console.log(`📌 Itens principais: ${filteredItems.length}`);

    // ===============================
    // KPIs
    // ===============================
    const total = filteredItems.length;

    const done = filteredItems.filter(i =>
      (i.fields["System.State"] || "")
        .toLowerCase()
        .includes("done")
    ).length;

    const active = filteredItems.filter(i => {

      const state = (
        i.fields["System.State"] || ""
      ).toLowerCase();

      return (
        state.includes("active") ||
        state.includes("andamento")
      );

    }).length;

    const blocked = filteredItems.filter(i =>
      (i.fields["System.State"] || "")
        .toLowerCase()
        .includes("blocked")
    ).length;

    const progress = total > 0
      ? Math.round((done / total) * 100)
      : 0;

    // ===============================
    // PROCESSA CARDS
    // ===============================
    filteredItems.forEach(item => {

      const fields = item.fields || {};

      const status =
        fields["System.State"] || "Sem status";

      const title =
        fields["System.Title"] || "Sem título";

      const workItemType =
        fields["System.WorkItemType"] || "";

      const user = fields["System.AssignedTo"]
        ? (
            fields["System.AssignedTo"].displayName ||
            fields["System.AssignedTo"].uniqueName
          )
        : "Sem responsável";

      const column = mapKanbanColumn(status);

      const card = {
        id: item.id,
        titulo: title,
        responsavel: user,
        status,
        tipo: workItemType
      };

      kanban[column].push(card);

      // USERS
      if (!users[user]) {

        users[user] = {
          nome: user,
          total: 0,
          done: 0,
          active: 0
        };
      }

      users[user].total += 1;

      if (column === "Concluído") {
        users[user].done += 1;
      }

      if (column === "Em Andamento") {
        users[user].active += 1;
      }
    });

    // ===============================
    // USERS ARRAY
    // ===============================
    const usersArray = Object.values(users)
      .map(u => ({
        ...u,
        taxaConclusao:
          u.total > 0
            ? Math.round((u.done / u.total) * 100)
            : 0
      }))
      .sort((a, b) => b.total - a.total);

    // ===============================
    // CACHE FINAL
    // ===============================
    cache.dashboard = {
      kpis: {
        total,
        done,
        active,
        blocked,
        progress
      },
      kanban,
      users: usersArray,
      updatedAt: new Date(),
      totalItemsAzure: allItems.length,
      totalItemsFiltrados: filteredItems.length
    };

    cache.lastSync = new Date();

    console.log("✅ Sync concluído");

  } catch (err) {

    console.error("❌ Sync error");

    console.error(err.response?.data || err.message);

  } finally {

    cache.loading = false;
  }
}

// ===============================
// 🟢 HEALTH CHECK
// ===============================
app.get('/', (req, res) => {

  res.send('API funcionando 🚀');
});

// ===============================
// 📊 DASHBOARD
// ===============================
app.get('/dashboard', async (req, res) => {

  try {

    if (!cache.dashboard) {

      console.log("⚠️ Cache vazio");

      await syncDashboard();
    }

    res.json(cache.dashboard);

  } catch (err) {

    console.error(err.message);

    res.status(500).json({
      error: "Erro ao carregar dashboard"
    });
  }
});

// ===============================
// 📋 DETALHE CARD + CHECKLIST
// ===============================
app.get('/checklist/:id', async (req, res) => {

  const { id } = req.params;

  try {

    console.log(`📋 Abrindo checklist ${id}`);

    // ===============================
    // CARD PAI
    // ===============================
    const parent = await axios.get(
      `https://dev.azure.com/${ORG}/${PROJECT}/_apis/wit/workitems/${id}?$expand=relations&api-version=7.0`,
      {
        headers: {
          Authorization: `Basic ${auth}`
        },
        timeout: 60000
      }
    );

    const fields = parent.data.fields || {};

    const titulo =
      fields["System.Title"] || "Sem título";

    const responsavel =
      fields["System.AssignedTo"]?.displayName ||
      "Sem responsável";

    const status =
      fields["System.State"] || "Sem status";

    const tipo =
      fields["System.WorkItemType"] || "";

    const descricao =
      fields["System.Description"] || "";

    const relations =
      parent.data.relations || [];

    console.log("RELATIONS:");
console.log(JSON.stringify(relations, null, 2));

    // ===============================
    // FILHOS
    // ===============================
    const children = relations.filter(r =>
      r.rel === 'System.LinkTypes.Hierarchy-Forward'
    );

    const ids = children.map(c =>
      c.url.split('/').pop()
    );

    let checklist = [];

    if (ids.length > 0) {

      const chunkSize = 50;

      let allChildren = [];

      for (let i = 0; i < ids.length; i += chunkSize) {

        const chunk = ids.slice(i, i + chunkSize);

        const resp = await axios.get(
          `https://dev.azure.com/${ORG}/${PROJECT}/_apis/wit/workitems?ids=${chunk.join(',')}&api-version=7.0`,
          {
            headers: {
              Authorization: `Basic ${auth}`
            },
            timeout: 60000
          }
        );

        allChildren = allChildren.concat(resp.data.value);
      }

      checklist = allChildren.map(item => {

  const fields = item.fields || {};

  const status = fields["System.State"] || "Sem status";

  const normalized = status.toLowerCase();

  const concluido =
    normalized.includes("done") ||
    normalized.includes("closed") ||
    normalized.includes("completed") ||
    normalized.includes("resolved") ||
    normalized.includes("concl");

  return {
    id: item.id,
    titulo: fields["System.Title"] || "Sem título",
    status,
    responsavel:
      fields["System.AssignedTo"]?.displayName ||
      "Sem responsável",
    concluido
  };
});
    }

    // ===============================
    // PROGRESSO
    // ===============================
    const total = checklist.length;

    const concluidos = checklist.filter(i => i.concluido).length;

    const progresso =
      total > 0
        ? Math.round((concluidos / total) * 100)
        : 0;

    // ===============================
    // RESPONSE
    // ===============================
    res.json({
      id,
      titulo,
      responsavel,
      status,
      tipo,
      descricao,
      progresso,
      total,
      concluidos,
      checklist
    });

  } catch (error) {

    console.error(error.response?.data || error.message);

    res.status(500).json({
      error: 'Erro ao montar checklist'
    });
  }
});

// ===============================
// 🔄 FORCE SYNC
// ===============================
app.post('/sync', async (req, res) => {

  try {

    await syncDashboard();

    res.json({
      success: true,
      message: "Sync executado com sucesso",
      lastSync: cache.lastSync
    });

  } catch (err) {

    console.error(err.message);

    res.status(500).json({
      error: "Erro ao executar sync"
    });
  }
});

// ===============================
// 🚀 START SERVER
// ===============================
app.listen(PORT, async () => {

  console.log(`🚀 Servidor rodando na porta ${PORT}`);

  // PRIMEIRO SYNC
  await syncDashboard();

  // AUTO SYNC 10 MIN
  setInterval(() => {

    console.log("⏱️ Auto sync iniciado");

    syncDashboard();

  }, 1000 * 60 * 10);
});
