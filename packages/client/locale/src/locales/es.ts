import type { CommonKey } from './zh.ts'

/** es base dictionary for the common namespace, checked complete against the zh key set. */
export const es = {
  'ok': 'Aceptar',
  'cancel': 'Cancelar',
  'close': 'Cerrar',
  'copy': 'Copiar',
  'copied': 'Copiado',
  'retry': 'Reintentar',
  'loading': 'Cargando…',
  'load.failed': 'Error al cargar',
  'submit': 'Enviar',
  'submitting': 'Enviando…',
  'next': 'Siguiente',
  'previous': 'Anterior',
  'skip': 'Omitir',
  'delete': 'Eliminar',
  'edit': 'Editar',
  'save': 'Guardar',
  'search': 'Buscar',
  'more': 'Más',
  'collapse': 'Contraer',
  'expand': 'Expandir',
  'back': 'Volver',
  'unknown': 'Desconocido',
  'none': 'Ninguno',
  'truncated': 'Truncado',
} satisfies Record<CommonKey, string>
