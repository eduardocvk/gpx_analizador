# ⛰️ GPX Tracker

Analizador de rutas GPX con mapas interactivos y perfiles altimétricos coloreados por pendiente.

## Funcionalidades

- 📂 **Carga de archivos GPX** desde el dispositivo
- 🗺️ **Mapa interactivo** (OpenStreetMap + Leaflet)
- 📊 **Perfil altimétrico** coloreado por pendiente (ECharts)
- ⛰️ **Detección automática de subidas y puertos** con categoría, desnivel y pendientes
- 📍 **Ubicación GPS sobre la ruta** con distancia al track y kilómetro más cercano
- ✏️ **Creador y editor de rutas** con inversión, eliminación de puntos y variantes
- 🖼️ **Miniaturas con silueta y perfil** de los tracks guardados
- 💾 **Guardado local y en la nube** (IndexedDB + Supabase)
- 🔄 **Sincronización entre móvil y ordenador** mediante acceso seguro por correo
- 📱 **PWA instalable** en Android, iOS y escritorio
- 📶 **Funciona offline** (Service Worker)

## Escala de pendientes

| Color | Rango | Tipo |
|-------|-------|------|
| 🟩 Verde | 0% - 3% | Llano |
| 🟨 Amarillo | 3% - 6% | Subida suave |
| 🟧 Naranja | 6% - 10% | Subida exigente |
| 🔴 Rojo | 10% - 15% | Puerto duro |
| 🟤 Granate | 15% - 20% | Muro |
| ⬛ Negro | > 20% | Pared |
| 🔵 Azul | < 0% | Descenso |

## Tecnologías

- [Leaflet](https://leafletjs.com/) - Mapas
- [ECharts](https://echarts.apache.org/) - Gráficos
- [TailwindCSS](https://tailwindcss.com/) - Estilos
- IndexedDB - Caché local y funcionamiento sin conexión
- Supabase - Autenticación y almacenamiento sincronizado con RLS

## Despliegue

Hospedado en GitHub Pages: [https://eduardocvk.github.io/gpx_analizador/](https://eduardocvk.github.io/gpx_analizador/)

La base de datos se versiona mediante las migraciones incluidas en `supabase/migrations`.
