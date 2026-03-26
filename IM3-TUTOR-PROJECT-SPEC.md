# IM3 Tutor — Tutor Virtual IA para Proyectos

## Descripción
Plataforma SaaS de tutores virtuales con IA que se integra en cualquier aplicación web como widget embebible. Cada tutor está entrenado con la documentación/manuales del proyecto y ayuda a los usuarios finales a navegar la aplicación en tiempo real. Se construye UNA vez y se configura por proyecto — no se reescribe para cada cliente.

## Stack Técnico
- **Backend:** Node.js + Express + TypeScript
- **Base de datos:** PostgreSQL + Drizzle ORM
- **IA:** Anthropic Claude (RAG — Retrieval Augmented Generation)
- **Storage:** Supabase Storage (PDFs y documentos)
- **Widget:** Vanilla JavaScript + Shadow DOM (embebible en cualquier web)
- **Deploy:** Railway

## Arquitectura

```
┌──────────────────────┐     ┌─────────────────────┐
│  CRM de IM3          │     │  im3-tutor          │
│  (hub.im3systems.com)│────▶│  (tutor.im3.com)    │
│                      │ API │                     │
│  • Crear tutor       │     │  • Almacenar docs   │
│  • Subir docs        │     │  • RAG + Claude     │
│  • Ver analytics     │     │  • Servir widget    │
│  • Copiar snippet    │     │  • Conversaciones   │
└──────────────────────┘     └─────────────────────┘
                                       │
                              widget.js (CDN)
                                       │
                    ┌──────────────────────────────┐
                    │  App del cliente (cualquiera) │
                    │                              │
                    │  <script src="tutor.im3.com  │
                    │    /widget.js"               │
                    │    data-tutor="abc123">       │
                    │  </script>                   │
                    │                              │
                    │              ┌───┐           │
                    │              │🤖│ ← click    │
                    │              └───┘           │
                    └──────────────────────────────┘
```

## Estructura de Carpetas
```
im3-tutor/
├── server/
│   ├── index.ts              # Express server + API routes
│   ├── db.ts                 # PostgreSQL + Drizzle ORM connection
│   ├── rag.ts                # Document processing: PDF extraction, chunking, embeddings
│   ├── chat.ts               # Claude API with RAG context injection
│   ├── storage.ts            # Supabase Storage for PDF uploads
│   └── auth.ts               # API key validation for CRM integration
├── widget/
│   ├── tutor-widget.ts       # Widget source (compiles to JS)
│   └── styles.css            # Widget styles (injected via Shadow DOM)
├── shared/
│   └── schema.ts             # Drizzle ORM table definitions
├── dist/
│   └── widget.js             # Compiled embeddable widget
├── package.json
├── tsconfig.json
├── drizzle.config.ts
└── CLAUDE.md                 # ← Este archivo
```

## Modelo de Datos (PostgreSQL)

### Tabla: tutors
| Campo | Tipo | Descripción |
|-------|------|-------------|
| id | UUID PK | ID único del tutor |
| projectName | text | Nombre del proyecto (ej: "Passport2Fluency") |
| clientName | text | Nombre del cliente (ej: "Sebastián Garzón") |
| welcomeMessage | text | Mensaje de bienvenida personalizado |
| systemPrompt | text | Instrucciones específicas para el comportamiento del tutor |
| theme | text | "light" o "dark" |
| accentColor | text | Color del widget (hex, ej: "#2FA4A9") |
| language | text | "es" o "en" |
| apiKey | text | API key para autenticar requests del CRM |
| isActive | boolean | Si el tutor está activo |
| createdAt | timestamp | Fecha de creación |

### Tabla: tutor_documents
| Campo | Tipo | Descripción |
|-------|------|-------------|
| id | UUID PK | ID único |
| tutorId | UUID FK | Referencia al tutor |
| name | text | Nombre del archivo (ej: "Manual de usuario.pdf") |
| type | text | "pdf", "text", "url" |
| content | text | Texto extraído del documento |
| chunks | json | Texto dividido en chunks para RAG |
| originalUrl | text | URL del archivo en Supabase Storage |
| createdAt | timestamp | Fecha de carga |

### Tabla: tutor_conversations
| Campo | Tipo | Descripción |
|-------|------|-------------|
| id | UUID PK | ID único |
| tutorId | UUID FK | Referencia al tutor |
| sessionId | text | ID de sesión del usuario (anónimo) |
| createdAt | timestamp | Inicio de la conversación |

### Tabla: tutor_messages
| Campo | Tipo | Descripción |
|-------|------|-------------|
| id | UUID PK | ID único |
| conversationId | UUID FK | Referencia a la conversación |
| role | text | "user" o "assistant" |
| content | text | Contenido del mensaje |
| docsUsed | json | IDs de documentos usados para la respuesta |
| createdAt | timestamp | Fecha del mensaje |

## API Endpoints

### Públicos (widget → servidor)
| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | /api/tutor/:id/config | Obtiene configuración del tutor (nombre, tema, bienvenida) |
| POST | /api/tutor/:id/chat | Envía mensaje y recibe respuesta IA |
| POST | /api/tutor/:id/feedback | Rating de la respuesta (thumbs up/down) |

### Admin (CRM → servidor, requiere API key)
| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | /api/admin/tutors | Crear nuevo tutor |
| PATCH | /api/admin/tutors/:id | Actualizar configuración del tutor |
| DELETE | /api/admin/tutors/:id | Eliminar tutor |
| POST | /api/admin/tutors/:id/documents | Subir documento (PDF/texto) |
| DELETE | /api/admin/tutors/:id/documents/:docId | Eliminar documento |
| GET | /api/admin/tutors/:id/analytics | Stats: preguntas frecuentes, uso, satisfacción |
| GET | /api/admin/tutors/:id/conversations | Historial de conversaciones |

### Widget (servido como archivo estático)
| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | /widget.js | Script embebible del widget |

## Pipeline RAG (Retrieval Augmented Generation)

### 1. Ingesta de documentos
```
PDF upload → Extracción de texto (pdf-parse) → Limpieza → Chunking (500 tokens/chunk) → Almacenar chunks en DB
```

### 2. Consulta del usuario
```
Mensaje del usuario
    → Buscar chunks relevantes (búsqueda por similitud de texto)
    → Construir prompt con contexto:
        System: "Eres un tutor virtual de {projectName}. Responde SOLO con información de los documentos."
        Context: [chunks relevantes]
        User: mensaje del usuario
    → Claude genera respuesta
    → Guardar en DB
    → Devolver al widget
```

### 3. Búsqueda de chunks (v1 simple)
Para el MVP, usar búsqueda por palabras clave (trigram matching con PostgreSQL `pg_trgm`).
Para v2, migrar a embeddings con `pgvector`.

## Widget Embebible

### Integración (1 línea de código)
```html
<script src="https://tutor.im3systems.com/widget.js" data-tutor="TUTOR_ID" data-theme="light" data-position="bottom-right"></script>
```

### Comportamiento
- Renderiza un botón flotante en la esquina (posición configurable)
- Click → abre ventana de chat (iframe o Shadow DOM)
- Chat con historial de la sesión actual
- Responsive (se adapta a móvil)
- Shadow DOM para aislar CSS del host (no rompe estilos del cliente)

### Configuración via data attributes
| Atributo | Valores | Default |
|----------|---------|---------|
| data-tutor | UUID del tutor | requerido |
| data-theme | "light" / "dark" | "light" |
| data-position | "bottom-right" / "bottom-left" | "bottom-right" |
| data-language | "es" / "en" | "es" |
| data-color | hex color | "#2FA4A9" |

## Flujo de Trabajo para Cada Nuevo Proyecto

1. IM3 termina de desarrollar el proyecto del cliente
2. IM3 redacta/genera los manuales (PDF, texto)
3. En el CRM de IM3 → proyecto → tab "Tutor IA" → crea tutor
4. Sube los PDFs y documentos de entrenamiento
5. Copia el snippet de código
6. Pega el snippet en la app del cliente (1 línea)
7. El tutor está listo — el usuario final puede usarlo

## Variables de Entorno
```
DATABASE_URL=postgresql://...
ANTHROPIC_API_KEY=sk-ant-...
SUPABASE_URL=https://...
SUPABASE_SERVICE_KEY=eyJ...
ADMIN_API_KEY=im3-tutor-admin-key-...  # Para auth entre CRM y tutor
PORT=5001
```

## Convenciones de Código
- TypeScript estricto — nunca usar `any`
- Errores de API: `res.status(4xx).json({ error: "..." })`
- Validación con Zod en endpoints
- Logs con timestamp: `[HH:MM:SS] mensaje`
- Respuestas del tutor siempre en el idioma configurado
- El tutor NUNCA inventa información — solo responde con lo que está en los documentos
- Si no sabe la respuesta, dice: "No tengo información sobre eso. Te sugiero contactar al equipo de soporte."

## Lo que NO hacer
- No usar Redux (usar TanStack Query si hay frontend admin)
- No instalar librerías nuevas sin necesidad
- No hacer el widget pesado (target: <50KB)
- No almacenar datos sensibles del usuario final
- No permitir que el tutor ejecute acciones en la app del cliente (solo responde preguntas)
- No hardcodear prompts — todo configurable por tutor

## Fases de Desarrollo

### Fase 1: Servidor base + API
- Express + PostgreSQL + Drizzle
- CRUD de tutors y documents
- Auth con API key
- Upload de PDFs → extracción de texto → chunking

### Fase 2: Chat con RAG
- Endpoint de chat
- Búsqueda de chunks relevantes
- Integración Claude con contexto
- Almacenamiento de conversaciones

### Fase 3: Widget embebible
- Script JS con Shadow DOM
- Botón flotante + ventana de chat
- Configuración via data attributes
- Build/minify del widget

### Fase 4: Integración con CRM
- Tab "Tutor IA" en el admin de proyectos del CRM de IM3
- Subir docs desde el CRM
- Copiar snippet desde el CRM
- Analytics básicos

### Fase 5: Mejoras
- Embeddings con pgvector para mejor búsqueda
- Sugerencias de preguntas frecuentes
- Feedback (thumbs up/down) y analytics
- Modo "guía paso a paso" (tutorial interactivo)
