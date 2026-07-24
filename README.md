# ⛰️ GPX Tracker

Analizador de rutas GPX con mapas interactivos y perfiles altimétricos coloreados por pendiente.

## Funcionalidades

- 📂 **Carga de archivos GPX** desde el dispositivo
- 🗺️ **Mapa interactivo** (OpenStreetMap + Leaflet)
- 📊 **Perfil altimétrico** coloreado por pendiente (ECharts)
- 💾 **Guardado local** de tracks (IndexedDB)
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
- IndexedDB - Almacenamiento local

## Despliegue

Hospedado en GitHub Pages: [https://eduardocvk.github.io/gpx_analizador/](https://eduardocvk.github.io/gpx_analizador/)
